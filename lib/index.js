/**
 * Host half of `dsh-plugin-session-delete`.
 *
 * DSH ships no Session deletion: `ui-workspace` states the limitation outright
 * ("sessions can be archived but never deleted"), and no Host service exposes a
 * delete verb — neither `sessionPersistence` nor `sessionQuery` has one. This
 * Host half therefore composes deletion from the primitives DSH does expose,
 * in an order that keeps every durable owner consistent:
 *
 *   1. read the Session's stored header             (`sessionPersistence.stat`)
 *   2. refuse a live or running Session             (`sessions`, `agents`,
 *                                                    `sessionController.list`)
 *   3. release the workspace account slot           (`workspaceRegistry`:
 *      unpin, unarchive, then `Workspace.detachSession`) — the authoritative
 *      membership the sidebar derives its rows from
 *   4. remove the durable Session artifact          (the session directory the
 *      persistence backend itself names, plus its rotated generations)
 *
 * The browser reaches this half through one authenticated Host route; the
 * Client half of this package owns the menu row and the confirmation dialog.
 *
 * The projection cache (`sessionProjectionCache`) is deliberately untouched:
 * it owns no delete verb, it is documented as fail-soft and self-healing, and
 * its rows are keyed by a lifecycle identity that a deleted Session can no
 * longer present.
 *
 * @module dsh-plugin-session-delete
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Diagnostic name of this Host plugin. */
export const name = 'session-delete'

/**
 * The one service this Host half hard-depends on: the authenticated fetch
 * carrier that serves the browser route below.
 */
export const inject = ['connection']

/** Absolute registration path of the browser-callable deletion route. */
export const SESSION_DELETE_PATH = '/api/session.delete'

/** Longest accepted Session id; real ids are far shorter and always opaque. */
const MAX_SESSION_ID_LENGTH = 200

/** Failure codes the Client half localizes. */
export const SESSION_DELETE_CODES = Object.freeze([
  'bad-request',
  'not-found',
  'live',
  'running',
  'unavailable',
  'failed',
])

/**
 * Read the composition's `connection` service.
 *
 * `connection` is a hard dependency of this plugin, but the Host composition
 * mounts services through a proxy, so the read goes through `Reflect.get` the
 * way the shipped Host plugins do rather than through a property access the
 * bundler could fold away.
 *
 * @param ctx - the Host context carrying `connection`.
 * @returns the connection face exposing `fetch.register`.
 */
function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/**
 * Resolve one optional Host service without turning its absence into a hard
 * failure: a composition that mounts no workspace registry still deletes the
 * artifact, it simply has no account slot to release.
 *
 * @param ctx - the Host context.
 * @param key - exact service key.
 * @returns the service, or `undefined`.
 */
function optional(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

/**
 * Build one JSON response for the browser route.
 *
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 * @returns the response.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Parse and validate the request payload.
 *
 * @param request - the buffered POST request.
 * @returns the Session id, or `undefined` when the payload is unusable.
 */
async function readSessionId(request) {
  let payload
  try {
    payload = await request.json()
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object') return undefined
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string') return undefined
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) return undefined
  if (sessionId.includes('\u0000') || /[\\/]/u.test(sessionId)) return undefined
  return sessionId
}

/**
 * Decide whether the Session still has live or running work.
 *
 * Deletion of an attached Session is refused rather than attempted: the
 * append-only writer holds the artifact open (on Windows an open file cannot be
 * removed at all), the loop would keep committing events into a directory that
 * no longer exists, and the Session store would keep publishing a log nobody
 * can read back. Refusing is the honest answer; the caller archives or closes
 * the Session first.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session under test.
 * @param signal - caller cancellation.
 * @returns the refusal code, or `undefined` when deletion may proceed.
 */
async function liveOrRunning(ctx, sessionId, signal) {
  const sessions = optional(ctx, 'sessions')
  if (sessions !== undefined && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) {
    return 'live'
  }
  const agents = optional(ctx, 'agents')
  if (agents !== undefined && typeof agents.get === 'function' && agents.get(sessionId) !== undefined) {
    return 'live'
  }
  const controller = optional(ctx, 'sessionController')
  if (controller !== undefined && typeof controller.list === 'function') {
    try {
      const listed = await controller.list({}, signal)
      const summary = listed?.items?.find((item) => item.sessionId === sessionId)
      if (summary?.running === true) return 'running'
    } catch {
      /* A failed listing is not evidence of running work; the live guards above
       * already covered every attached Session. */
    }
  }
  return undefined
}

/**
 * Release the Session's workspace account slot so the sidebar row disappears
 * with the artifact.
 *
 * `Workspace.sessionIds` is documented as the authoritative membership the
 * browser derives rows from ("members without a summary are omitted until it
 * arrives"), and it survives a missing summary by design — so a deleted
 * Session left on the account would linger as a row waiting for a summary that
 * can never arrive. Pin and archive sets are exclusive bookkeeping for a
 * Session that no longer exists, so both are cleared first.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session to detach.
 * @returns the ids of the workspaces that contained it.
 */
async function detachFromWorkspaces(ctx, sessionId) {
  const registry = optional(ctx, 'workspaceRegistry')
  if (registry === undefined) return []
  const detached = []
  if (typeof registry.unpinSession === 'function') await registry.unpinSession(sessionId)
  if (typeof registry.unarchiveSession === 'function') await registry.unarchiveSession(sessionId)
  if (typeof registry.list !== 'function') return detached
  for (const workspace of registry.list()) {
    if (typeof workspace?.sessionIds?.includes !== 'function') continue
    if (!workspace.sessionIds.includes(sessionId)) continue
    if (typeof workspace.detachSession !== 'function') continue
    await workspace.detachSession(sessionId)
    detached.push(workspace.workspaceId)
  }
  return detached
}

/**
 * Drop the deleted Session's row from the persisted projection cache.
 *
 * The cache owns no delete verb of its own, but it is a `session_projcache`
 * storage domain, so the row is removed through the domain that owns it rather
 * than by deleting the medium behind the domain's back — the in-memory table
 * and the durable file stay coherent.
 *
 * A stale cache row is inert (it is keyed by a lifecycle identity a deleted
 * Session can no longer present, and every listing is bounded by
 * `sessionPersistence.list()`), so a failure here is non-fatal: the deletion
 * has already succeeded by the time this runs.
 *
 * @param ctx - the Host context.
 * @param sessionId - the deleted Session.
 * @returns whether a cache row was claimed for removal.
 */
async function dropProjectionCacheRow(ctx, sessionId) {
  const storageDomain = optional(ctx, 'storageDomain')
  if (storageDomain === undefined || typeof storageDomain.get !== 'function') return false
  let table
  try {
    table = storageDomain.get('session_projcache')?.table?.('sessions')
  } catch {
    return false
  }
  if (table === undefined || typeof table.delete !== 'function') return false
  try {
    await table.delete(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Tell every connected client that the Session is gone.
 *
 * `api-session/removed` is the shipped signal for exactly this event: the
 * session-controller emits it when a Session is disposed, `api-remotes`
 * forwards it (it is on that package's forwarded-event allowlist), and the
 * client's session-controller drops the row from its list on receipt. Without
 * it the client keeps a phantom row — its list only ever grows from
 * `api-session/added` and is otherwise refreshed on reconnect — and a deleted
 * Session that no Workspace accounts for surfaces under Ungrouped, where
 * opening it fails with `session/not-found`.
 *
 * Emitted only after the artifact is really gone, so the client can never drop
 * a row that is still on disk.
 *
 * @param ctx - the Host context.
 * @param sessionId - the deleted Session.
 * @returns whether the notification was dispatched.
 */
function announceRemoval(ctx, sessionId) {
  try {
    ctx.emit('api-session/removed', sessionId)
    return true
  } catch (error) {
    ctx.logger?.warn?.(`session-delete: could not announce removal of ${sessionId}: ${String(error)}`)
    return false
  }
}

/**
 * Ask the mounted persistence backend where one Session's artifact lives.
 *
 * The backend names its own layout (`locate(header)` for the JSONL backend);
 * this plugin never re-derives a project-directory key of its own, because a
 * second implementation of that encoding is a future outage, not a feature.
 *
 * @param persistence - the mounted persistence service.
 * @param header - the stored Session header returned by `stat`.
 * @returns the absolute artifact path, or `undefined` when unnamed.
 */
function locateArtifact(persistence, header) {
  if (typeof persistence.locate !== 'function') return undefined
  try {
    const located = persistence.locate(header)
    const path = located?.path
    return typeof path === 'string' && path.length > 0 ? resolve(path) : undefined
  } catch {
    return undefined
  }
}

/**
 * Find one Session's directory by scanning the configured root, two levels
 * deep — the fallback for a backend that exposes no `locate`.
 *
 * The scan only ever returns a directory whose final segment is exactly the
 * Session id, so it can never name an unrelated artifact.
 *
 * @param root - the persistence root, when the backend exposes one.
 * @param sessionId - the Session whose directory is wanted.
 * @returns the absolute directory, or `undefined`.
 */
async function scanForSessionDir(root, sessionId) {
  if (typeof root !== 'string' || root.length === 0) return undefined
  const base = resolve(root)
  let projects
  try {
    projects = await readdir(base, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(base, project.name)
    let children
    try {
      children = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    if (children.some((child) => child.isDirectory() && child.name === sessionId)) {
      return join(projectDir, sessionId)
    }
  }
  return undefined
}

/**
 * Prove that `target` is a directory this plugin is allowed to delete.
 *
 * Removal is the one irreversible operation here, so the guard is explicit:
 * the path must be absolute, its final segment must be exactly the Session id,
 * and it must sit strictly inside the persistence root that named it. A path
 * that fails any clause is reported, never deleted.
 *
 * @param target - candidate absolute path.
 * @param sessionId - the Session that must own the final segment.
 * @param root - the persistence root, when known.
 * @returns `true` when deletion is provably scoped to this Session.
 */
function isDeletableArtifactDir(target, sessionId, root) {
  if (!isAbsolute(target)) return false
  const resolved = resolve(target)
  if (resolved.split(sep).at(-1) !== sessionId) return false
  if (typeof root !== 'string' || root.length === 0) return true
  const base = resolve(root)
  const rel = relative(base, resolved)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Remove one Session's durable artifact directory.
 *
 * @param persistence - the mounted persistence service.
 * @param header - the stored Session header.
 * @param sessionId - the Session to remove.
 * @returns a report of what was resolved, guarded, and removed.
 */
async function removeArtifact(persistence, header, sessionId) {
  const root = typeof persistence.root === 'string' ? persistence.root : undefined
  const located = locateArtifact(persistence, header)
  const target = located !== undefined ? dirname(located) : await scanForSessionDir(root, sessionId)
  if (target === undefined) return { resolved: false, removed: false, path: undefined }
  if (!isDeletableArtifactDir(target, sessionId, root)) {
    return { resolved: true, removed: false, path: target }
  }
  try {
    const info = await stat(target)
    if (!info.isDirectory()) return { resolved: true, removed: false, path: target }
  } catch {
    return { resolved: true, removed: false, path: target }
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
  return { resolved: true, removed: true, path: target }
}

/**
 * Handle one browser deletion request.
 *
 * @param ctx - the Host context.
 * @param request - the buffered POST request.
 * @returns the JSON response describing the outcome.
 */
async function handleSessionDelete(ctx, request) {
  const sessionId = await readSessionId(request)
  if (sessionId === undefined) {
    return json(400, { ok: false, code: 'bad-request', message: 'expected a JSON body carrying one safe sessionId' })
  }

  const persistence = optional(ctx, 'sessionPersistence')
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    return json(500, { ok: false, code: 'unavailable', message: 'no session persistence service is mounted' })
  }

  let snapshot
  try {
    snapshot = await persistence.stat(sessionId, { signal: request.signal })
  } catch (error) {
    return json(500, { ok: false, code: 'failed', message: String(error?.message ?? error) })
  }
  if (snapshot === undefined) {
    return json(404, { ok: false, code: 'not-found', message: 'no stored Session carries this id' })
  }

  const refusal = await liveOrRunning(ctx, sessionId, request.signal)
  if (refusal !== undefined) {
    return json(409, {
      ok: false,
      code: refusal,
      message: refusal === 'running'
        ? 'the Session still has running work; stop it before deleting'
        : 'the Session is open in this process; close or archive it before deleting',
    })
  }

  // The artifact goes first, and nothing else is touched until it is really
  // gone. Every later step is then a cleanup of a deletion that already
  // happened: a failure here can no longer leave a Session that is half
  // removed — detached from its Workspace but still on disk, which is exactly
  // the phantom-row shape this ordering exists to avoid.
  let artifact
  try {
    artifact = await removeArtifact(persistence, snapshot.header, sessionId)
  } catch (error) {
    return json(500, { ok: false, code: 'failed', message: `artifact removal failed: ${String(error?.message ?? error)}` })
  }

  if (!artifact.removed) {
    return json(500, {
      ok: false,
      code: 'failed',
      message: artifact.resolved
        ? 'the Session artifact was located but refused by the removal guard, so nothing was changed'
        : 'the Session artifact could not be located, so nothing was changed',
    })
  }

  let detached
  try {
    detached = await detachFromWorkspaces(ctx, sessionId)
  } catch (error) {
    return json(500, { ok: false, code: 'failed', message: `workspace detach failed: ${String(error?.message ?? error)}` })
  }

  const cacheRowDropped = await dropProjectionCacheRow(ctx, sessionId)
  const announced = announceRemoval(ctx, sessionId)

  return json(200, {
    ok: true,
    sessionId,
    artifactRemoved: true,
    artifactResolved: artifact.resolved,
    artifactPath: artifact.path,
    detachedFrom: detached,
    cacheRowDropped,
    announced,
  })
}

/**
 * Register the deletion route.
 *
 * The row is inserted by this package's bundle patch, so `apply` runs on the
 * Host whenever the profile mounts the bundle.
 *
 * @param ctx - the Host context carrying `connection`.
 */
export function apply(ctx) {
  connectionOf(ctx).fetch.register({
    path: SESSION_DELETE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await handleSessionDelete(ctx, request)
      } catch (error) {
        ctx.logger?.error?.(error)
        return json(500, { ok: false, code: 'failed', message: String(error?.message ?? error) })
      }
    },
  })
}
