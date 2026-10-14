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
 *   2. refuse a live or running Session             (`sessions.get`,
 *                                                    `agents.get`,
 *                                                    `workspace/session-activity`)
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

import { lstat, readdir, rm } from 'node:fs/promises'
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

/** Read-only route the confirmation dialog uses to describe what a delete will remove. */
export const SESSION_DELETE_PREVIEW_PATH = '/api/session.delete.preview'

/** Longest accepted Session id; real ids are far shorter and always opaque. */
const MAX_SESSION_ID_LENGTH = 200

/**
 * Failure codes the Client half localizes.
 *
 * This list, the two locale dictionaries, `lib/types/index.d.ts`, and the
 * Client's `KNOWN_FAILURE_CODES` describe one vocabulary and must be changed
 * together. The Client additionally synthesizes `'network'`, which never comes
 * from here because it means "the Host could not be reached".
 */
export const SESSION_DELETE_CODES = Object.freeze([
  'bad-request',
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
  // Path-traversal names are never Session ids, and the removal guard compares
  // directory names to this value — so reject them at the door rather than
  // relying on a later check to notice.
  if (sessionId === '.' || sessionId === '..') return undefined
  return sessionId
}

/**
 * Ask every `workspace/session-activity` listener what is still running on
 * this Session.
 *
 * This is the exact read-only probe the shipped archive path uses before it
 * refuses an archive, so it already knows the whole family of live work: the
 * turn in progress, running subagents, background jobs and scheduled
 * reminders. Querying it is strictly better than reading the Session list —
 * a running turn, a live job and a due schedule are three different reasons to
 * refuse, and only this waterfall sees all three.
 *
 * A listener failure propagates (fail-closed), exactly as it does in the
 * shipped `archiveSession`, which does not contain this waterfall either. The
 * tempting alternative — treat "the probe blew up" as "the Session is idle" —
 * is wrong for the one operation this plugin performs: deletion is
 * irreversible, so a probe that cannot answer must not be read as permission.
 * The cost of failing closed is a retryable 500; the cost of failing open is
 * deleting a Session that was mid-write.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session under test.
 * @param signal - caller cancellation.
 * @returns the reported activity entries, empty when the Session is idle.
 * @throws when a listener fails or the caller aborted.
 */
async function activeWork(ctx, sessionId, signal) {
  signal?.throwIfAborted?.()
  if (typeof ctx.waterfall !== 'function') return []
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  return Array.isArray(activity) ? activity : []
}

/**
 * Test whether the Host currently holds this Session live in memory.
 *
 * A live Session is one this process has entered — the conversation that is
 * open now, plus every conversation resumed since startup. Nothing evicts one
 * while the process lives: a Session's detach disposer runs when the fiber that
 * created it is disposed (the session-controller's own root fiber), and the
 * `agents` service exposes no dispose verb at all (`create`/`resume`/`get`/
 * `list` only), so the Host cannot hand a live Session back.
 *
 * This is not the same thing as *attached on the client*. The browser retains a
 * `Session` wrapper for every row it renders so the status dot has a source,
 * and that is why a `sessions.get` check here does not refuse the sidebar — it
 * refuses only what the Host really entered. `ApiSessionList.list()` unions
 * live Sessions with persisted ones, so a live Session whose artifact was
 * removed comes straight back on the next list refresh, and its log can no
 * longer be appended to.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session under test.
 * @returns `true` when a live Session or Agent holds this id.
 */
function isLiveInHost(ctx, sessionId) {
  return (
    optional(ctx, 'sessions')?.get?.(sessionId) !== undefined ||
    optional(ctx, 'agents')?.get?.(sessionId) !== undefined
  )
}

/**
 * Decide whether the Session must be refused.
 *
 * Two different refusals, for two different reasons:
 *
 *   - `'live'` — the Host holds the Session in memory, so deleting its
 *     artifact cannot stick: `listSessions()` unions live Sessions with
 *     persisted ones, the row returns on the next refresh, and the surviving
 *     Session is left as a zombie whose writes fail with ENOENT. Nothing in
 *     DSH can evict a live Session, so the honest answer is "restart Harness
 *     and delete it then" — not a delete that silently undoes itself.
 *   - `'running'` — the shipped activity probe reports work in flight (a turn,
 *     subagents, background jobs, due reminders). Deleting now would pull the
 *     artifact out from under a writer.
 *
 * The shipped `Workspace.archiveSession` refuses only the second case, because
 * archiving writes a durable flag rather than removing the artifact: a live
 * Session keeps its slot and unarchiving restores it. Removal is not
 * reversible that way, so the live case has to be refused here.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session under test.
 * @param signal - caller cancellation.
 * @returns the refusal code, or `undefined` when deletion may proceed.
 */
async function liveOrRunning(ctx, sessionId, signal) {
  if (isLiveInHost(ctx, sessionId)) return 'live'
  const activity = await activeWork(ctx, sessionId, signal)
  return activity.length > 0 ? 'running' : undefined
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
 * @returns the ids of the workspaces that contained it, and any step that failed.
 */
async function detachFromWorkspaces(ctx, sessionId) {
  const registry = optional(ctx, 'workspaceRegistry')
  if (registry === undefined) return { detached: [], failed: [] }
  const detached = []
  const failed = []
  // Every step is independent: one that throws must not skip the others, or a
  // half-released Session leaves the durable account inconsistent for no
  // better reason than that a later step was never reached. `attempt` reports
  // success so a caller can tell what actually happened.
  const attempt = async (what, run) => {
    try {
      await run()
      return true
    } catch (error) {
      failed.push(`${what}: ${String(error?.message ?? error)}`)
      return false
    }
  }
  await attempt('unpin', () => registry.unpinSession?.(sessionId))
  await attempt('unarchive', () => registry.unarchiveSession?.(sessionId))
  if (typeof registry.list !== 'function') return { detached, failed }
  let workspaces
  try {
    workspaces = registry.list()
  } catch (error) {
    failed.push(`list: ${String(error?.message ?? error)}`)
    return { detached, failed }
  }
  for (const workspace of workspaces) {
    if (typeof workspace?.detachSession !== 'function') continue
    // `sessionIds` is a FILTERED getter (`record.sessionIds.filter(id =>
    // host.sessionPath(id) === record.path)`) over an in-memory header index
    // that is rebuilt on operations this plugin does not control. Using it as a
    // gate therefore risks skipping the release for a Session that really is
    // accounted, e.g. when a re-index between the `rm` and this loop drops the
    // id from the getter. `detachSession` is idempotent — its own prune is
    // authoritative and a non-member is a no-op that writes nothing — so the
    // release is unconditional and the filtered getter only decides what the
    // response REPORTS.
    let listed = false
    try {
      listed = workspace.sessionIds?.includes?.(sessionId) === true
    } catch {
      /* the filtered getter is advisory; the release below is not */
    }
    const released = await attempt(`detach ${workspace.id ?? '?'}`, () => workspace.detachSession(sessionId))
    if (released && listed) detached.push(workspace.id)
  }
  return { detached, failed }
}

/**
 * Collect every `origin: 'subagent'` Session below one Session, depth-first.
 *
 * Subagent Sessions are the one kind of child that is NOT safe to leave behind
 * when its parent goes. Unlike a fork — which is a `structuredClone`d copy that
 * becomes an ordinary independent Session — a subagent Session keeps a
 * `parentSession` that is used as an **authorization witness**: access requires
 * a two-part address, and a parent that no longer exists makes the child
 * permanently unreachable (see `subagent/unauthorized` in the session
 * controller). Hidden from the sidebar by `origin: 'subagent'`, such an orphan
 * is invisible, unopenable, and unremovable through any surface.
 *
 * They are also stored as **siblings**, not nested: `sessionDir` is
 * `<root>/<project>/<id>/` and looks at neither `origin` nor `parentSession`,
 * so deleting a parent directory never reaches them.
 *
 * DSH's own export treats the whole tree as one Session (`includeDescendants`,
 * packed as `subagents/<id>/…`), so removing them with the parent is the
 * shipped meaning of "delete this session". Fork branches are deliberately NOT
 * collected here: they are independent copies and survive the parent intact.
 *
 * The whole header is collected, not just the id, because the persistence
 * backend names each artifact from `header.cwd` (`logPath(root, meta.cwd,
 * meta.id)`), and a synthetic `{ id }` resolves to the backend's `_no-cwd`
 * project instead of the one the Session is really stored under — pointing the
 * removal at a path that does not exist and leaving the real child behind. The
 * child inherits the parent's `cwd` (`childSessionMeta`), so the header the
 * trace already carries is what the backend needs.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session whose subagent descendants are wanted.
 * @returns the descendant `{ id, header }` pairs, nearest first, deepest last.
 */
async function collectSubagentDescendants(ctx, sessionId) {
  const query = optional(ctx, 'sessionQuery')
  if (query === undefined || typeof query.traceSession !== 'function') return []
  let lineage
  try {
    lineage = await query.traceSession(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`session-delete: could not trace ${sessionId}: ${String(error)}`)
    return []
  }
  const collected = []
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      const header = node?.session?.header
      if (header?.origin === 'subagent' && typeof header.id === 'string') collected.push({ id: header.id, header })
      walk(node?.descendants)
    }
  }
  walk(lineage?.descendants)
  return collected
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
 * @returns whether a cache row was really removed.
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
    // `KvTableImpl.delete` resolves `false` when the key is absent, so the
    // result is the only honest answer to "did a row go away". A backend that
    // resolves nothing at all is read as success (`!== false`), not as failure.
    return (await table.delete(sessionId)) !== false
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
 * `lstat` rather than `stat`: a symlink or junction at the target path is
 * refused instead of unlinked, because a link is not evidence that this
 * Session owns what is behind it. (Recursion never follows one either — both
 * cases were measured, not assumed.)
 *
 * Every way this can decline reports WHICH way, because the two callers turn the
 * result into user-facing copy: "artifact not removed" alone cannot tell a
 * Session that woke up from one the path guard refused, and a report that
 * cannot be acted on is barely a report.
 *
 * @param persistence - the mounted persistence service.
 * @param header - the stored Session header.
 * @param sessionId - the Session to remove.
 * @param stillIdle - re-check run immediately before the irreversible step. It
 *   returns the refusal code (`'live'`/`'running'`) or `undefined` when the
 *   Session may still be removed.
 * @returns a report of what was resolved, guarded, and removed, plus the reason
 *   when `removed` is false (`'unlocated'`, `'guard'`, `'missing'`,
 *   `'not-a-directory'`, `'stayed'`, or the re-check's own code).
 */
async function removeArtifact(persistence, header, sessionId, stillIdle) {
  const root = typeof persistence.root === 'string' ? persistence.root : undefined
  const located = locateArtifact(persistence, header)
  const target = located !== undefined ? dirname(located) : await scanForSessionDir(root, sessionId)
  if (target === undefined) return { resolved: false, removed: false, path: undefined, reason: 'unlocated' }
  if (!isDeletableArtifactDir(target, sessionId, root)) {
    return { resolved: true, removed: false, path: target, reason: 'guard' }
  }
  try {
    const info = await lstat(target)
    if (!info.isDirectory()) return { resolved: true, removed: false, path: target, reason: 'not-a-directory' }
  } catch {
    return { resolved: true, removed: false, path: target, reason: 'missing' }
  }
  if (stillIdle !== undefined) {
    const refusal = await stillIdle()
    if (refusal !== undefined) return { resolved: true, removed: false, path: target, reason: refusal }
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
  // `removed` is only true once the directory is really gone: a caller uses it
  // to decide whether the Session may be announced as removed to clients.
  let gone = true
  try {
    await lstat(target)
    gone = false
  } catch {
    /* absent, which is what we wanted */
  }
  return gone
    ? { resolved: true, removed: true, path: target }
    : { resolved: true, removed: false, path: target, reason: 'stayed' }
}

/**
 * Run the post-deletion bookkeeping that must happen whether or not there was
 * still an artifact to remove.
 *
 * Release the workspace account slot, drop the projection-cache row, and
 * announce the removal to clients. Idempotent by construction: every step is a
 * no-op when there is nothing left to release, so calling it for a Session
 * that is already gone is how a stale sidebar row gets dismissed instead of
 * leaving the user with a row that only ever answers `session/not-found`.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session being finished off.
 * @returns the fields the response reports, plus any cleanup failure.
 */
async function finishDeletion(ctx, sessionId) {
  const warnings = []
  let detachedFrom = []
  try {
    const detachReport = await detachFromWorkspaces(ctx, sessionId)
    detachedFrom = detachReport.detached
    warnings.push(...detachReport.failed)
  } catch (error) {
    warnings.push(`workspace: ${String(error?.message ?? error)}`)
  }
  const cacheRowDropped = await dropProjectionCacheRow(ctx, sessionId)
  const announced = announceRemoval(ctx, sessionId)
  return { detachedFrom, cacheRowDropped, announced, warnings }
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
    // The artifact is already gone, so the user's goal — this Session not
    // existing — is met. Return success and finish the bookkeeping anyway,
    // because that is what dismisses the stale row: a client list entry that
    // outlives its storage is otherwise a dead end (the delete keeps failing,
    // so the row can never be removed through the UI).
    //
    // Such a row is real: the workspace registry indexes persisted headers at
    // startup and live ones only through `attachSession`, so a Session that is
    // live but unpersisted is listed yet accounted by no Workspace — it lands
    // in "Ungrouped" and `persistence.stat` has nothing to find.
    //
    // This path deliberately stays a success even when the Session is live,
    // unlike the artifact-present path above: the request reached a Session
    // whose storage is already gone, so refusing would leave the user holding a
    // row that no operation can ever dismiss. The `liveInMemory` flag tells the
    // Client the truth — the row will return on the next list refresh, because
    // `listSessions` unions live Sessions with persisted ones.
    const finished = await finishDeletion(ctx, sessionId)
    const liveInMemory = isLiveInHost(ctx, sessionId)
    return json(200, {
      ok: true,
      sessionId,
      alreadyGone: true,
      artifactRemoved: false,
      liveInMemory,
      detachedFrom: finished.detachedFrom,
      cacheRowDropped: finished.cacheRowDropped,
      announced: finished.announced,
      ...(finished.warnings.length > 0 ? { cleanupWarnings: finished.warnings } : {}),
    })
  }

  const refusal = await liveOrRunning(ctx, sessionId, request.signal)
  if (refusal !== undefined) {
    return json(409, {
      ok: false,
      code: refusal,
      message:
        refusal === 'live'
          ? 'this Session is live in the running Host: its log would be re-listed and could no longer be written to, so it is refused until Harness restarts'
          : 'this Session still has running work (a turn, subagents, background jobs or scheduled reminders); stop it before deleting',
    })
  }

  // The artifact goes first, and nothing else is touched until it is really
  // gone. Every later step is then a cleanup of a deletion that already
  // happened: a failure here can no longer leave a Session that is half
  // removed — detached from its Workspace but still on disk, which is exactly
  // the phantom-row shape this ordering exists to avoid.
  // Subagent descendants are collected up front so the response can report
  // exactly what was removed alongside the Session.
  const subagents = await collectSubagentDescendants(ctx, sessionId)

  const stillIdle = () => liveOrRunning(ctx, sessionId, request.signal)
  let artifact
  try {
    artifact = await removeArtifact(persistence, snapshot.header, sessionId, stillIdle)
  } catch (error) {
    return json(500, { ok: false, code: 'failed', message: `artifact removal failed: ${String(error?.message ?? error)}` })
  }

  if (!artifact.removed) {
    // Name the real obstacle: a Session that became live or started running
    // between the two checks is a retryable condition, while a path the guard
    // refused is not the same problem at all.
    const why = {
      unlocated: 'the Session artifact could not be located',
      guard: 'the Session artifact was located but refused by the removal guard',
      missing: 'the Session artifact is no longer on disk',
      'not-a-directory': 'the Session artifact is not a directory',
      stayed: 'the Session artifact is still present after removal',
      live: 'the Session became live in the Host before it could be removed',
      running: 'the Session started running again before it could be removed',
    }[artifact.reason]
    return json(500, {
      ok: false,
      code: 'failed',
      message: `${why ?? 'the Session artifact could not be removed'} (${artifact.reason ?? 'unknown'}), so nothing was changed`,
    })
  }

  // Past this point the Session is gone and the answer is success. Cleanup is
  // best-effort and its failures are reported, never turned into an error: a
  // 200-but-nothing-else signal is what leaves the client holding a phantom row
  // for a Session that is already deleted, which is the one outcome worse than
  // a stale workspace entry. The removal is always announced, whatever the
  // cleanup did.
  // Subagent descendants go with their parent. They are siblings on disk and
  // keyed to the parent for authorization, so a parent that is gone strands
  // them permanently: invisible, unopenable, unremovable. Removal is
  // best-effort per child — one that fails must not stop the others — and each
  // one is announced so any client row it held disappears too.
  //
  // Each child is removed through its OWN stored header (the trace handed it
  // over with `cwd` intact) and re-checks its own idleness first: the trace was
  // taken before the parent's artifact was removed, so the window between
  // "collected" and "removed" is the widest one in this handler.
  const subagentRemoved = []
  const subagentFailed = []
  for (const child of subagents) {
    const childStillIdle = () => liveOrRunning(ctx, child.id, request.signal)
    let childArtifact
    try {
      childArtifact = await removeArtifact(persistence, child.header, child.id, childStillIdle)
    } catch (error) {
      subagentFailed.push(`${child.id}: ${String(error?.message ?? error)}`)
      continue
    }
    if (childArtifact.removed) {
      subagentRemoved.push(child.id)
      await dropProjectionCacheRow(ctx, child.id)
      announceRemoval(ctx, child.id)
    } else {
      // Say WHY it stayed. `removeArtifact` already knows: a child that woke up
      // reports `live`/`running`, one the guard refused reports `guard`, and one
      // that never had a directory reports `missing`.
      subagentFailed.push(`${child.id}: artifact not removed (${childArtifact.reason ?? 'unknown'})`)
    }
  }

  const finished = await finishDeletion(ctx, sessionId)
  // Re-read liveness AFTER the artifact is gone. Opening a Session in the
  // browser can promote and resume it asynchronously (the history controller's
  // `follow` → `promote` → `agents.resume`), so a Session that passed both
  // checks can still have been entered while `rm` ran. That is exactly the
  // zombie this plugin refuses to create silently, and the artifact is already
  // gone, so the honest response is a success that says so.
  const liveInMemory = isLiveInHost(ctx, sessionId)

  return json(200, {
    ok: true,
    sessionId,
    artifactRemoved: true,
    liveInMemory,
    detachedFrom: finished.detachedFrom,
    cacheRowDropped: finished.cacheRowDropped,
    announced: finished.announced,
    subagentsRemoved: subagentRemoved,
    ...(subagentFailed.length > 0 ? { subagentWarnings: subagentFailed } : {}),
    ...(finished.warnings.length > 0 ? { cleanupWarnings: finished.warnings } : {}),
  })
}

/**
 * Describe what a delete would remove, without removing anything.
 *
 * The confirmation dialog shows the subagent count because that is the one
 * part of a deletion a reader cannot see coming: subagent Sessions never
 * appear in the sidebar (`origin: 'subagent'` is hidden), so a parent with a
 * dozen of them would otherwise be deleted far more broadly than it looks.
 *
 * @param ctx - the Host context.
 * @param request - the buffered POST request.
 * @returns the JSON preview, or a refusal mirroring the delete route.
 */
async function handleSessionDeletePreview(ctx, request) {
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
    // Already gone: nothing left to describe or to cascade. The dialog still
    // opens so the user can confirm, and the delete route's already-gone path
    // finishes the bookkeeping.
    return json(200, { ok: true, sessionId, subagentIds: [], alreadyGone: true })
  }
  const subagentIds = (await collectSubagentDescendants(ctx, sessionId)).map((child) => child.id)
  return json(200, { ok: true, sessionId, subagentIds })
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
    path: SESSION_DELETE_PREVIEW_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await handleSessionDeletePreview(ctx, request)
      } catch (error) {
        ctx.logger?.error?.(error)
        return json(500, { ok: false, code: 'failed', message: String(error?.message ?? error) })
      }
    },
  })
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
