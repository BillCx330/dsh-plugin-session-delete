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
 *   2. refuse a Session with work in flight         (`workspace/session-activity`)
 *      and REPORT (never refuse) one the Host still  (`sessions.get`,
 *      holds live                                     `agents.get`)
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
 * Name the store that holds a Session live, for diagnostics.
 *
 * `agents` wins when both answer: an agent means the Session was resumed, not
 * merely entered. Which store matched is the difference between "the user is in
 * this conversation" and "some Host path touched it", and a report that cannot
 * say which one it was is not answerable.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session under test.
 * @returns `'agents'`, `'sessions'`, or `undefined` when the Host holds neither.
 */
function liveSourceOf(ctx, sessionId) {
  if (optional(ctx, 'agents')?.get?.(sessionId) !== undefined) return 'agents'
  if (optional(ctx, 'sessions')?.get?.(sessionId) !== undefined) return 'sessions'
  return undefined
}

/**
 * Evict a Session from the Host's live store before its artifact is removed.
 *
 * This is what makes a deletion *stick*. `ApiSessionList.list()` unions live
 * Sessions with persisted ones, so a Session still resident in the store comes
 * back on the next list rebuild after its artifact is gone — and its writes then
 * fail because the directory no longer exists. Removing it from the store first
 * closes both holes: the row cannot return, and `session/disposed` (which the
 * session service emits on detach and the session controller forwards as
 * `api-session/removed`) drops it in every connected client.
 *
 * The session service exposes exactly two primitives for this — `liveEntryFor`
 * and `detachEntered` — and neither is a public "close" verb, so the agent that
 * owns the Session stays registered; that is the one part this plugin cannot
 * reach. It is still an improvement on leaving the Session published: an idle
 * agent with an unpublished Session is invisible, while a published zombie is a
 * dead row.
 *
 * Ordering is load-bearing, and it is done by the CALLER: the activity probe must
 * pass first (so a running turn is never detached), this runs second, and only
 * then may the artifact be removed. After detaching, a durability barrier
 * (`sessionPersistence.flush()`, which flushes every active write handle) drains
 * anything already in flight so a late flush cannot recreate the log behind the
 * removal.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session about to be deleted.
 * @returns whether it was evicted, and why not when it was not.
 */
async function detachLiveSession(ctx, sessionId) {
  const sessions = optional(ctx, 'sessions')
  if (sessions === undefined || typeof sessions.get !== 'function') return { detached: false }
  const live = sessions.get(sessionId)
  if (live === undefined) return { detached: false }
  // Belt and braces behind the activity probe: never evict a Session whose agent
  // reports a running turn, or the turn's next append lands in a detached session.
  const agent = optional(ctx, 'agents')?.get?.(sessionId)
  if (agent !== undefined && agent.status === 'running') return { detached: false, refused: 'running' }
  if (typeof sessions.liveEntryFor !== 'function' || typeof sessions.detachEntered !== 'function') {
    return { detached: false, unsupported: true }
  }
  try {
    sessions.detachEntered(sessions.liveEntryFor(live))
  } catch (error) {
    return { detached: false, error: String(error?.message ?? error) }
  }
  try {
    await optional(ctx, 'sessionPersistence')?.flush?.()
  } catch {
    /* the barrier is best-effort: the directory is about to be removed anyway */
  }
  return { detached: true }
}

/**
 * Decide whether the Session still has work in flight.
 *
 * Only the shipped activity probe refuses a deletion. Being held live by the
 * Host is deliberately NOT a refusal, and this is a deliberate reversal of an
 * earlier design that did refuse it: in a real deployment (the desktop app with
 * its bundles mounted) the live store can answer for every Session a user can
 * see, which turns a "refuse the live ones" rule into "refuse everything" — the
 * plugin stops being able to delete at all. A rule that cannot delete anything
 * is not honesty, it is a bug.
 *
 * What the live case costs is handled rather than blocked: the Session is
 * evicted from the live store first (`detachLiveSession`), so the row cannot
 * come back, and then the artifact, workspace slot, cache row and reminders all
 * go away. When that eviction is unavailable (an older composition, or a
 * detached agent the plugin cannot reach), `liveInMemory`/`liveSource` still say
 * what was left behind.
 *
 * A Session that is *running* is a different matter: the activity probe reports
 * a turn, subagents, background jobs or due reminders, and deleting then would
 * pull the artifact out from under a writer. That still refuses.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session under test.
 * @param signal - caller cancellation.
 * @returns the refusal code, or `undefined` when deletion may proceed.
 */
async function runningWork(ctx, sessionId, signal) {
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
 * corpus already carries is what the backend needs.
 *
 * The tree is discovered by SCANNING the corpus for `parentSession`, not by
 * `traceSession(parent)`. `traceSession` throws when the target is absent from
 * the corpus, and an absent parent is exactly the case where children are left
 * stranded — including every orphan an earlier version of this plugin created by
 * deleting a parent without its children. A child carries `parentSession`
 * regardless of whether the parent still exists, so scanning finds those too.
 * The walk is breadth-first (nearest first, deepest last) and cycle-safe.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session whose subagent descendants are wanted.
 * @param signal - caller cancellation for the corpus read.
 * @returns the descendant `{ id, header }` pairs, nearest first, deepest last.
 */
async function collectSubagentDescendants(ctx, sessionId, signal) {
  const query = optional(ctx, 'sessionQuery')
  if (query === undefined) return []

  let records
  try {
    if (typeof query.listSessions === 'function') {
      records = await query.listSessions(signal)
    } else if (typeof query.traceSession === 'function') {
      // Older compositions expose only the trace; it covers the ordinary case
      // (parent still present) but cannot see children of an absent parent.
      const lineage = await query.traceSession(sessionId, signal)
      const flattened = []
      const walk = (nodes) => {
        for (const node of nodes ?? []) {
          const header = node?.session?.header
          if (header?.origin === 'subagent' && typeof header.id === 'string') flattened.push({ id: header.id, header })
          walk(node?.descendants)
        }
      }
      walk(lineage?.descendants)
      return flattened
    } else {
      return []
    }
  } catch (error) {
    // A corpus that cannot be read is NOT evidence that there are no children.
    // Swallowing this would delete a parent while leaving its subagents behind —
    // exactly the orphan shape this whole file exists to prevent — so the caller
    // is told instead, and the artifact-present path aborts before touching
    // anything.
    throw new Error(`could not enumerate subagent descendants of ${sessionId}: ${String(error?.message ?? error)}`)
  }

  const childrenByParent = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    const header = record?.header
    if (header?.origin !== 'subagent' || typeof header.id !== 'string' || typeof header.parentSession !== 'string') continue
    const children = childrenByParent.get(header.parentSession) ?? []
    children.push({ id: header.id, header })
    childrenByParent.set(header.parentSession, children)
  }

  const collected = []
  const seen = new Set([sessionId])
  const queue = [sessionId]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const child of childrenByParent.get(parent) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      collected.push(child)
      queue.push(child.id)
    }
  }
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
 * Session whose own probe reported work from one the path guard refused, and a
 * report that cannot be acted on is barely a report.
 *
 * @param persistence - the mounted persistence service.
 * @param header - the stored Session header.
 * @param sessionId - the Session to remove.
 * @param stillIdle - re-check run immediately before the irreversible step. It
 *   returns the refusal code (`'running'`) or `undefined` when the Session may
 *   still be removed.
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
 * Delete the scheduled reminders bound to one Session.
 *
 * A reminder owns a durable row keyed by its Session (`{ sessionId, record }` in
 * the `schedule` domain), and deleting a Session leaves those rows pointing at
 * something that no longer exists: they never fire again, but they accumulate in
 * the reminders list and in every `catalog()` read. The schedule service owns a
 * delete verb, so the rows are removed through it rather than behind its back.
 *
 * The service is optional (the schedule bundle is experimental): a composition
 * without it simply has no reminders to purge.
 *
 * @param ctx - the Host context.
 * @param sessionId - the Session being deleted.
 * @returns how many tasks were removed, plus any task that could not be.
 */
async function purgeScheduledTasks(ctx, sessionId) {
  const schedule = optional(ctx, 'schedule')
  if (schedule === undefined || typeof schedule.catalog !== 'function' || typeof schedule.delete !== 'function') {
    return { removed: 0, failed: [] }
  }
  let tasks
  try {
    tasks = await schedule.catalog()
  } catch (error) {
    return { removed: 0, failed: [`schedule catalog: ${String(error?.message ?? error)}`] }
  }
  const failed = []
  let removed = 0
  for (const task of Array.isArray(tasks) ? tasks : []) {
    // `delete` takes both identities and refuses a mismatch, so a task is only
    // ever removed for the Session that owns it.
    if (typeof task?.id !== 'string' || task.sessionId !== sessionId) continue
    try {
      const result = await schedule.delete({ id: task.id, sessionId })
      if (result?.deleted === true) removed += 1
      else failed.push(`schedule ${task.id}: not deleted (${result?.code ?? 'unknown'})`)
    } catch (error) {
      failed.push(`schedule ${task.id}: ${String(error?.message ?? error)}`)
    }
  }
  return { removed, failed }
}

/**
 * Run the post-deletion bookkeeping that must happen whether or not there was
 * still an artifact to remove.
 *
 * Release the workspace account slot, drop the projection-cache row, delete the
 * scheduled reminders bound to the Session, and announce the removal to clients.
 * Idempotent by construction: every step is a no-op when there is nothing left
 * to release, so calling it for a Session that is already gone is how a stale
 * sidebar row gets dismissed instead of leaving the user with a row that only
 * ever answers `session/not-found`.
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
  let scheduledTasksRemoved = 0
  try {
    const purgeReport = await purgeScheduledTasks(ctx, sessionId)
    scheduledTasksRemoved = purgeReport.removed
    warnings.push(...purgeReport.failed)
  } catch (error) {
    warnings.push(`schedule: ${String(error?.message ?? error)}`)
  }
  const announced = announceRemoval(ctx, sessionId)
  return { detachedFrom, cacheRowDropped, scheduledTasksRemoved, announced, warnings }
}

/**
 * Remove one Session's collected subagent descendants.
 *
 * Shared by both delete paths so a child is treated identically whether its
 * parent's artifact was still there or had already vanished. Per child:
 *
 *   1. evict it from the live store (`detachLiveSession`), unless its agent is
 *      running — an evicted-but-published child would otherwise come back;
 *   2. remove the artifact through its OWN header (`removeArtifact`), guarded and
 *      re-checked for work in flight;
 *   3. run the same bookkeeping a top-level deletion gets — release any workspace
 *      slot (a subagent Session is not normally accounted for by a Workspace, but
 *      `detachSession` is idempotent and a Session can be attached by any client),
 *      drop the cache row, purge its reminders, and announce the removal.
 *
 * One child that fails never stops the others, and nothing here can fail the
 * caller's request: the parent's artifact is already gone by the time this runs.
 *
 * @param ctx - the Host context.
 * @param persistence - the mounted persistence service.
 * @param children - `{ id, header }` pairs from `collectSubagentDescendants`.
 * @param signal - caller cancellation for the per-child activity check.
 * @returns the ids actually removed, plus one warning per child left behind.
 */
async function removeDescendants(ctx, persistence, children, signal) {
  const removed = []
  const failed = []
  for (const child of children) {
    const eviction = await detachLiveSession(ctx, child.id)
    if (eviction.refused === 'running') {
      failed.push(`${child.id}: artifact not removed (running)`)
      continue
    }
    const childStillIdle = () => runningWork(ctx, child.id, signal)
    let artifact
    try {
      artifact = await removeArtifact(persistence, child.header, child.id, childStillIdle)
    } catch (error) {
      failed.push(`${child.id}: ${String(error?.message ?? error)}`)
      continue
    }
    if (!artifact.removed) {
      // Say WHY it stayed: a child whose own probe reported work says `running`,
      // one the guard refused says `guard`, one with no directory says `missing`.
      failed.push(`${child.id}: artifact not removed (${artifact.reason ?? 'unknown'})`)
      continue
    }
    removed.push(child.id)
    try {
      const finished = await finishDeletion(ctx, child.id)
      failed.push(...finished.warnings.map((warning) => `${child.id}: ${warning}`))
    } catch (error) {
      failed.push(`${child.id}: cleanup: ${String(error?.message ?? error)}`)
    }
    if (eviction.error !== undefined) failed.push(`${child.id}: live detach: ${eviction.error}`)
  }
  return { removed, failed }
}

/**
 * Answer a request whose Session artifact is already gone.
 *
 * The user's goal — this Session not existing — is met, so the response is a
 * success; what remains is the bookkeeping that dismisses the row plus the
 * descendants that would otherwise be stranded, including the children of a
 * parent an earlier version of this plugin deleted without them.
 *
 * Used both when `stat` finds nothing and when the artifact disappears between
 * `stat` and the removal (a concurrent delete, or something outside the plugin),
 * so two races answer identically instead of one becoming a 500 that changed
 * nothing.
 *
 * @param ctx - the Host context.
 * @param persistence - the mounted persistence service.
 * @param sessionId - the Session that is already gone.
 * @param subagents - its collected descendants.
 * @param signal - caller cancellation.
 * @param eviction - the `detachLiveSession` result, when one was attempted.
 * @returns the JSON response.
 */
async function respondAlreadyGone(ctx, persistence, sessionId, subagents, signal, eviction, extraWarnings = []) {
  const cascaded = await removeDescendants(ctx, persistence, subagents, signal)
  const finished = await finishDeletion(ctx, sessionId)
  const liveInMemory = isLiveInHost(ctx, sessionId)
  const liveSource = liveInMemory ? liveSourceOf(ctx, sessionId) : undefined
  const warnings = [...extraWarnings, ...finished.warnings]
  if (eviction?.error !== undefined) warnings.push(`live detach: ${eviction.error}`)
  return json(200, {
    ok: true,
    sessionId,
    alreadyGone: true,
    artifactRemoved: false,
    liveDetached: eviction?.detached === true,
    liveInMemory,
    ...(liveSource === undefined ? {} : { liveSource }),
    detachedFrom: finished.detachedFrom,
    cacheRowDropped: finished.cacheRowDropped,
    scheduledTasksRemoved: finished.scheduledTasksRemoved,
    announced: finished.announced,
    subagentsRemoved: cascaded.removed,
    ...(cascaded.failed.length > 0 ? { subagentWarnings: cascaded.failed } : {}),
    ...(warnings.length > 0 ? { cleanupWarnings: warnings } : {}),
  })
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

  // The activity gate runs before anything else that mutates state: a refusal has
  // to leave the Host exactly as it found it, so nothing is evicted and nothing
  // is removed until the probe has answered "idle".
  const refusal = await runningWork(ctx, sessionId, request.signal)
  if (snapshot !== undefined && refusal !== undefined) {
    return json(409, {
      ok: false,
      code: refusal,
      message:
        'this Session still has running work (a turn, subagents, background jobs or scheduled reminders); stop it before deleting',
    })
  }

  // Descendants are read from the corpus by `parentSession`, so this works when
  // the parent itself is already gone (the orphan shape an earlier version left
  // behind). A corpus read that fails is fatal for the artifact-present path: an
  // unknown child set must never turn into "delete the parent and hope".
  let subagents
  const scanWarnings = []
  try {
    subagents = await collectSubagentDescendants(ctx, sessionId, request.signal)
  } catch (error) {
    if (snapshot !== undefined) {
      return json(500, { ok: false, code: 'failed', message: `${String(error?.message ?? error)}, so nothing was changed` })
    }
    subagents = []
    scanWarnings.push(String(error?.message ?? error))
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
    // This path deliberately stays a success even when the Session is live:
    // the request reached a Session whose storage is already gone, so refusing
    // would leave the user holding a row that no operation can ever dismiss.
    // `liveInMemory` still reports the truth — the row can return on the next
    // list rebuild, because `listSessions` unions live Sessions with persisted
    // ones — but it does not block anything.
    //
    // The descendants still have to go. This is precisely the shape an earlier
    // version of this plugin created: the parent's artifact is gone and its
    // subagent children are stranded on disk, so this path removes them too.
    //
    // The parent is evicted from the live store first when it is not running, for
    // the same reason as the artifact-present path: a live Session left behind
    // comes back on the next list rebuild.
    const eviction = refusal === undefined ? await detachLiveSession(ctx, sessionId) : { detached: false }
    return respondAlreadyGone(ctx, persistence, sessionId, subagents, request.signal, eviction, scanWarnings)
  }

  // The artifact goes first, and nothing else is touched until it is really
  // gone. Every later step is then a cleanup of a deletion that already
  // happened: a failure here can no longer leave a Session that is half
  // removed — detached from its Workspace but still on disk, which is exactly
  // the phantom-row shape this ordering exists to avoid.
  //
  // Evicting the Session from the live store comes before the removal: it is what
  // makes the deletion stick (`listSessions` unions live Sessions in) and it emits
  // `session/disposed` → `api-session/removed`, which drops the row everywhere.
  // The activity gate already passed, and `detachLiveSession` re-checks the agent,
  // so a running turn is never detached.
  const eviction = await detachLiveSession(ctx, sessionId)
  if (eviction.refused === 'running') {
    return json(409, {
      ok: false,
      code: 'running',
      message: 'this Session started running again before it could be removed; stop it first',
    })
  }

  // Only work in flight re-checks the removal; being live does not, because the
  // Session was just evicted (or could not be, and that is reported).
  const stillIdle = () => runningWork(ctx, sessionId, request.signal)
  let artifact
  try {
    artifact = await removeArtifact(persistence, snapshot.header, sessionId, stillIdle)
  } catch (error) {
    return json(500, { ok: false, code: 'failed', message: `artifact removal failed: ${String(error?.message ?? error)}` })
  }

  if (!artifact.removed) {
    if (artifact.reason === 'running') {
      // A turn started between the gate and the removal. Nothing was touched, and
      // this is the same condition the first gate reports — so it is a 409, not a
      // 500 that reads like a broken deployment.
      return json(409, {
        ok: false,
        code: 'running',
        message: 'this Session started running again before it could be removed (running); stop it first, then retry',
      })
    }
    if (artifact.reason === 'missing') {
      // The artifact vanished between `stat` and the removal — a concurrent delete,
      // or something outside the plugin. The goal state holds, so finish exactly
      // like an already-gone Session instead of failing a request that changed
      // nothing and needs nothing.
      return respondAlreadyGone(ctx, persistence, sessionId, subagents, request.signal, eviction)
    }
    // Name the real obstacle: a path the guard refused is not the same problem as
    // a directory that is still present after `rm`.
    const why = {
      unlocated: 'the Session artifact could not be located',
      guard: 'the Session artifact was located but refused by the removal guard',
      'not-a-directory': 'the Session artifact is not a directory',
      stayed: 'the Session artifact is still present after removal',
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
  //
  // Subagent descendants go with their parent. They are siblings on disk and
  // keyed to the parent for authorization, so a parent that is gone strands them
  // permanently: invisible, unopenable, unremovable. `removeDescendants` evicts
  // each child from the live store, removes its artifact through its own header,
  // and runs the same bookkeeping the parent gets.
  const cascaded = await removeDescendants(ctx, persistence, subagents, request.signal)

  const finished = await finishDeletion(ctx, sessionId)
  // Report what the Host still holds AFTER the eviction attempt. A successful
  // detach leaves nothing behind; when it was unavailable, this says what the next
  // list rebuild may bring back.
  const liveInMemory = isLiveInHost(ctx, sessionId)
  const liveSource = liveInMemory ? liveSourceOf(ctx, sessionId) : undefined
  const warnings = [...finished.warnings]
  if (eviction.error !== undefined) warnings.push(`live detach: ${eviction.error}`)

  return json(200, {
    ok: true,
    sessionId,
    artifactRemoved: true,
    liveDetached: eviction.detached === true,
    liveInMemory,
    ...(liveSource === undefined ? {} : { liveSource }),
    detachedFrom: finished.detachedFrom,
    cacheRowDropped: finished.cacheRowDropped,
    scheduledTasksRemoved: finished.scheduledTasksRemoved,
    announced: finished.announced,
    subagentsRemoved: cascaded.removed,
    ...(cascaded.failed.length > 0 ? { subagentWarnings: cascaded.failed } : {}),
    ...(warnings.length > 0 ? { cleanupWarnings: warnings } : {}),
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
 * It also reports whether the Host holds the Session live (`live`/`liveSource`),
 * as diagnostics: the deletion evicts it, so this is no longer something the user
 * needs to act on.
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
  const liveSource = liveSourceOf(ctx, sessionId)
  const live = liveSource !== undefined
  if (snapshot === undefined) {
    // Already gone: nothing left to describe or to cascade. The dialog still
    // opens so the user can confirm, and the delete route's already-gone path
    // finishes the bookkeeping.
    return json(200, {
      ok: true,
      sessionId,
      subagentIds: [],
      alreadyGone: true,
      live,
      ...(liveSource === undefined ? {} : { liveSource }),
    })
  }
  const subagentIds = (await collectSubagentDescendants(ctx, sessionId)).map((child) => child.id)
  return json(200, {
    ok: true,
    sessionId,
    subagentIds,
    live,
    ...(liveSource === undefined ? {} : { liveSource }),
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
