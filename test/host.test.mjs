/**
 * Offline behavioural test for the Host half.
 *
 * Runs the real `lib/index.js` against a temporary session root: it proves the
 * route registration, every refusal path, the workspace-account release, and —
 * most importantly — that removal only ever happens for a directory provably
 * owned by the requested Session. No real profile storage is touched.
 */
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const host = await import(new URL('../lib/index.js', import.meta.url).href)

const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))

/** The cwd every seeded Session is stored under. */
const CWD = 'C:\\proj'
/** Project directory the real backend derives from that cwd. */
const PROJECT = '--proj--'
/** Project directory the real backend derives from a MISSING cwd. */
const NO_CWD = '_no-cwd'

/** Create one stored session directory under the fake persistence root. */
async function seedSession(project, sessionId) {
  const dir = join(root, project, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'not-a-real-log')
  return dir
}

/** Build a Host context over one fake deployment shape. */
function makeContext({ live = false, running = false, locate = true, outsidePath, failDetach = false, failUnpin = false, descendants = [], probeThrows = false, cacheDeleteReturns = true } = {}) {
  const state = {
    detached: [],
    unpinned: [],
    unarchived: [],
    emitted: [],
    cacheDropped: [],
    activityQueries: 0,
    traceIds: [],
    route: undefined,
    previewRoute: undefined,
  }

  const sessions = {
    // `session-zombie` is held live but has no stored artifact: the case where
    // a sidebar row outlives its storage and returns after a reconnect.
    get: (id) => (live && (id === 'session-live' || id === 'session-zombie') ? { id } : undefined),
  }

  const agents = { get: () => undefined }

  // The shipped archive path asks `workspace/session-activity` what is still
  // running on a Session; the plugin uses that same read-only probe, so the
  // fake reports through it rather than through a session list.
  const activityFor = (id) => (running && id === 'session-x' ? [{ kind: 'job', items: [{ id: 'job-1' }] }] : [])

  const persistence = {
    root,
    async stat(id) {
      if (id === 'session-missing' || id === 'session-zombie') return undefined
      return { header: { id, cwd: CWD, version: 4, createdAt: 0, isSeeded: false } }
    },
    ...(locate
      ? {
          // Mirrors the shipped JSONL backend: `logPath(root, meta.cwd,
          // meta.id)`, where an absent `cwd` selects `_no-cwd`. A fake that
          // ignored `cwd` would hide exactly the bug this file now guards.
          locate(header) {
            if (outsidePath !== undefined) return { kind: 'jsonl', path: outsidePath }
            const project = header.cwd === undefined ? NO_CWD : PROJECT
            return { kind: 'jsonl', path: join(root, project, header.id, 'session.v4.jsonl.zstd') }
          },
        }
      : {}),
  }

  const workspaceRegistry = {
    async unpinSession(id) {
      if (failUnpin) throw new Error('unpin blew up')
      state.unpinned.push(id)
    },
    async unarchiveSession(id) {
      state.unarchived.push(id)
    },
    list: () => [
      {
        // The real WorkspaceEntity exposes `id`, not `workspaceId` — the fake
        // mirrors the real shape, so a drift between them fails a test instead
        // of passing one.
        id: 'ws-1',
        sessionIds: ['session-x', 'session-live', 'session-busy'],
        async detachSession(id) {
          if (failDetach) throw new Error('detach blew up')
          state.detached.push(id)
        },
      },
    ],
  }

  const ctx = {
    logger: { error() {}, warn() {} },
    connection: {
      fetch: {
        register(route) {
          if (route.path.endsWith('.preview')) state.previewRoute = route
          else state.route = route
        },
      },
    },
    emit(event, ...args) {
      state.emitted.push([event, ...args])
    },
    async waterfall(event, request, next) {
      state.activityQueries += 1
      assert.equal(event, 'workspace/session-activity', 'the plugin must ask the shipped activity probe')
      return activityFor(request.sessionId) ?? (await next())
    },
    get(key) {
      switch (key) {
        case 'sessions':
          return sessions
        case 'agents':
          return agents
        case 'sessionPersistence':
          return persistence
        case 'sessionQuery':
          return {
            // Lineage shape mirrors the real service: nested `descendants`,
            // each node a `SessionRecord` whose header carries `origin` AND the
            // `cwd` the artifact is really stored under (`traceSession` clones
            // the whole record, so a real node always has one). A fixture that
            // dropped the cwd would make the cascade look correct here while
            // failing against the shipped backend.
            async traceSession(id) {
              state.traceIds.push(id)
              return { target: { header: { id: 'session-x', cwd: CWD } }, ancestors: [], descendants }
            },
          }
        case 'workspaceRegistry':
          return workspaceRegistry
        case 'storageDomain':
          return {
            get(name) {
              if (name !== 'session_projcache') return undefined
              return {
                table(tableName) {
                  assert.equal(tableName, 'sessions')
                  return {
                    async delete(id) {
                      state.cacheDropped.push(id)
                      return cacheDeleteReturns
                    },
                  }
                },
              }
            },
          }
        default:
          return undefined
      }
    },
  }

  if (probeThrows) {
    ctx.waterfall = async () => {
      state.activityQueries += 1
      throw new Error('activity listener blew up')
    }
  }

  return { ctx, state }
}

/** Post one payload to the registered route. */
async function post(route, body) {
  const request = new Request(`http://local${route.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const response = await route.fetch(request)
  return { status: response.status, payload: await response.json() }
}

/* --------------------------------------------------------- registration --- */

{
  const { ctx, state } = makeContext()
  host.apply(ctx)
  assert.ok(state.route, 'apply must register the deletion route')
  assert.equal(state.route.path, host.SESSION_DELETE_PATH)
  assert.deepEqual(state.route.methods, ['POST'])
}

/* ------------------------------------------------- happy path deletes it --- */

{
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext()
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.artifactRemoved, true)
  await assert.rejects(() => stat(dir), 'the session directory must be gone')
  assert.deepEqual(state.detached, ['session-x'], 'the workspace account slot must be released')
  assert.deepEqual(state.unpinned, ['session-x'], 'the pin entry must be cleared')
  assert.deepEqual(state.unarchived, ['session-x'], 'the archive entry must be cleared')
  assert.deepEqual(state.cacheDropped, ['session-x'], "the projection-cache row must be dropped")
  assert.equal(payload.cacheRowDropped, true)
  assert.deepEqual(
    state.emitted,
    [['api-session/removed', 'session-x']],
    'a deleted Session must be announced so the client drops its row',
  )
  assert.equal(payload.announced, true)
}

/* ------------------------------------------------- scan fallback (no locate) */

{
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext({ locate: false })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.equal(payload.artifactRemoved, true, 'the root scan must find the artifact without locate()')
  await assert.rejects(() => stat(dir))
}

/* ---------------------------------------------------------- refusals --- */

{
  const { ctx, state } = makeContext()
  host.apply(ctx)

  const malformed = await post(state.route, 'not json')
  assert.equal(malformed.status, 400)
  assert.equal(malformed.payload.code, 'bad-request')

  const traversal = await post(state.route, { sessionId: '../escape' })
  assert.equal(traversal.status, 400, 'a path-separator id must be rejected outright')

  const absent = await post(state.route, {})
  assert.equal(absent.status, 400)

  assert.deepEqual(state.detached, [], 'no refusal may touch workspace bookkeeping')
  assert.deepEqual(state.emitted, [], 'no refusal may announce a removal')
  assert.deepEqual(state.cacheDropped, [], 'no refusal may touch the projection cache')
}

{
  // A Session the HOST holds live is DELETED, not refused, and the response says
  // so. An earlier design refused it; in a real deployment the live store can
  // answer for every Session a user can see, which turned that rule into "refuse
  // everything" and made the plugin unable to delete at all. What the live case
  // really costs is bounded and is reported instead: the row can come back on the
  // next list rebuild (reconnect or refresh), and re-deleting is idempotent.
  const dir = await seedSession(PROJECT, 'session-live')
  const { ctx, state } = makeContext({ live: true })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-live' })
  assert.equal(status, 200, 'a Host-live Session must still be deletable')
  assert.equal(payload.ok, true)
  assert.equal(payload.artifactRemoved, true)
  assert.equal(payload.liveInMemory, true, 'the response must report that the Host still holds it')
  assert.equal(payload.liveSource, 'sessions', 'and which store held it')
  assert.equal(await stat(dir).then(() => true, () => false), false, 'the artifact must be gone')
  assert.deepEqual(state.detached, ['session-live'], 'the workspace slot must be released')
  assert.deepEqual(state.emitted, [['api-session/removed', 'session-live']], 'the row must be announced')
  assert.equal(state.activityQueries > 0, true, 'the activity probe is still asked')
}

{
  // A composition that mounts neither `sessions` nor `agents` must not turn the
  // new liveness check into a failure: with nothing to read, the Session simply
  // cannot be known to be live, and a cold deletion proceeds.
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext()
  const baseGet = ctx.get
  ctx.get = (key) => (key === 'sessions' || key === 'agents' ? undefined : baseGet(key))
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200, 'a composition without a live store must still delete')
  assert.equal(payload.artifactRemoved, true)
  await assert.rejects(() => stat(dir))
}

{
  // A live AGENT is enough on its own: the two stores the agent factory enters
  // are `sessions` and `agents`, and a Session can be held by the agent registry
  // while `sessions.get` has nothing. Dropping the `agents.get` half of the check
  // must fail here, and `liveSource` must name the store that matched.
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext()
  const baseGet = ctx.get
  ctx.get = (key) => (key === 'agents' ? { get: (id) => (id === 'session-x' ? { id } : undefined) } : baseGet(key))
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200, 'an agent-held Session must still be deletable')
  assert.equal(payload.artifactRemoved, true)
  assert.equal(payload.liveInMemory, true)
  assert.equal(payload.liveSource, 'agents', 'the agent registry is the store that held it')
  assert.equal(await stat(dir).then(() => true, () => false), false)
  assert.deepEqual(state.emitted, [['api-session/removed', 'session-x']])
}

{
  // The re-check before the irreversible step must fail closed too. A probe that
  // works for the first check and then blows up must stop the removal, not be
  // read as "idle".
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext()
  let calls = 0
  ctx.waterfall = async () => {
    calls += 1
    if (calls > 1) throw new Error('listener blew up mid-delete')
    return []
  }
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 500, 'a failing pre-removal re-check must fail the request')
  assert.equal(payload.code, 'failed')
  assert.match(payload.message, /artifact removal failed/u)
  assert.equal(await stat(dir).then(() => true), true, 'the artifact must survive a failed re-check')
  assert.deepEqual(state.detached, [])
  assert.deepEqual(state.emitted, [])

  await rm(dir, { recursive: true, force: true })
}

{
  // The same, for a child: its own re-check failing must leave that child alone
  // and be reported, while the parent still goes.
  await seedSession(PROJECT, 'session-x')
  const childDir = await seedSession(PROJECT, 'sub-boom')
  const tree = [{ session: { header: { id: 'sub-boom', cwd: CWD, origin: 'subagent', parentSession: 'session-x' } }, descendants: [] }]
  const { ctx, state } = makeContext({ descendants: tree })
  const baseWaterfall = ctx.waterfall
  ctx.waterfall = async (event, request, next) => {
    if (request.sessionId === 'sub-boom') throw new Error('child listener blew up')
    return baseWaterfall(event, request, next)
  }
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200, 'a failing child probe must not fail the parent deletion')
  assert.deepEqual(payload.subagentsRemoved, [])
  assert.equal(payload.subagentWarnings.length, 1)
  assert.match(payload.subagentWarnings[0], /sub-boom: child listener blew up/u)
  assert.equal(await stat(childDir).then(() => true), true, 'the child must survive its failed re-check')

  await rm(childDir, { recursive: true, force: true })
}

{
  // Scheduled reminders are durable rows keyed by their Session, so deleting a
  // Session must delete them too — otherwise every `catalog()` keeps reading
  // tasks that can never fire. Only tasks the deleted Session owns are touched,
  // and the service's own delete verb takes both identities.
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext()
  const deleted = []
  const baseGet = ctx.get
  ctx.get = (key) =>
    key === 'schedule'
      ? {
          async catalog() {
            return [
              { id: 'task-mine', sessionId: 'session-x', status: 'inactive' },
              { id: 'task-other', sessionId: 'session-other', status: 'active' },
            ]
          },
          async delete(request) {
            deleted.push(request)
            return { id: request.id, deleted: true }
          },
        }
      : baseGet(key)
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.deepEqual(deleted, [{ id: 'task-mine', sessionId: 'session-x' }], 'only the deleted Session’s tasks go')
  assert.equal(payload.scheduledTasksRemoved, 1, 'the response must report how many reminders went with it')
  await rm(dir, { recursive: true, force: true })
}

{
  // A reminder the schedule service refuses to delete is reported, never fatal:
  // the artifact is already gone by the time this runs.
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext()
  const baseGet = ctx.get
  ctx.get = (key) =>
    key === 'schedule'
      ? {
          async catalog() {
            return [{ id: 'task-stuck', sessionId: 'session-x', status: 'active' }]
          },
          async delete() {
            throw new Error('schedule store is read-only')
          },
        }
      : baseGet(key)
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200, 'a reminder that cannot be deleted must not fail the deletion')
  assert.equal(payload.scheduledTasksRemoved, 0)
  assert.match(payload.cleanupWarnings[0], /^schedule task-stuck:/u)
  await rm(dir, { recursive: true, force: true })
}

{
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext({ running: true })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 409)
  assert.equal(payload.code, 'running')
  assert.equal(state.activityQueries > 0, true, 'the shipped activity probe must be asked about a cold Session')
  await stat(dir)
  assert.deepEqual(state.detached, [])
  await rm(dir, { recursive: true, force: true })
}

{
  // A probe that fails must NOT be read as "idle". Deletion is irreversible, so
  // the destructive path has to fail closed: the shipped `archiveSession` does
  // not contain this waterfall either. The caller gets a retryable failure and
  // the artifact is untouched.
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext({ probeThrows: true })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 500, 'a failed activity probe must fail the request, not be treated as idle')
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'failed')
  assert.equal(await stat(dir).then(() => true), true, 'the artifact must survive a failed probe')
  assert.deepEqual(state.detached, [], 'a failed probe must not release the workspace slot')
  assert.deepEqual(state.emitted, [], 'a failed probe must not announce a removal')

  await rm(dir, { recursive: true, force: true })
}

/* ----------------------------------------------------- removal guard --- */

{
  // locate() names a directory outside the persistence root must never delete it.
  const outside = await mkdtemp(join(tmpdir(), 'dsh-session-delete-outside-'))
  const victim = join(outside, 'session-x')
  await mkdir(victim, { recursive: true })
  await writeFile(join(victim, 'keep-me'), 'x')

  const { ctx, state } = makeContext({ outsidePath: join(victim, 'session.v4.jsonl.zstd') })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 500, 'a refused removal is a failure, not a partial success')
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'failed')
  assert.match(payload.message, /removal guard \(guard\)/u, 'the message must name the guard, not a generic failure')
  await stat(join(victim, 'keep-me'))
  assert.deepEqual(state.detached, [], 'a Session still on disk must keep its workspace account slot')
  assert.deepEqual(state.emitted, [], 'a refused removal must not announce the Session as gone')
  assert.deepEqual(state.cacheDropped, [], 'a refused removal must not drop the cache row')

  await rm(outside, { recursive: true, force: true })
}

/* ----------------------------- subagent descendants go with their parent --- */

{
  // Subagent sessions are siblings on disk and authorized through their parent,
  // so a parent that is deleted strands them permanently. They must be removed
  // with it. A fork branch sitting in the same tree is a different thing: an
  // independent copy, and it must NOT be touched.
  //
  // Every header carries `cwd`, exactly as `traceSession`'s cloned records do:
  // the backend derives the artifact path from it (`logPath(root, meta.cwd,
  // meta.id)`), so a synthetic `{ id }` would name `_no-cwd/<id>` instead of the
  // real directory and the guard would report "artifact not removed" for a child
  // that is sitting right there.
  const tree = [
    {
      session: { header: { id: 'sub-a', cwd: CWD, origin: 'subagent', parentSession: 'session-x' } },
      descendants: [
        {
          session: { header: { id: 'sub-a1', cwd: CWD, origin: 'subagent', parentSession: 'sub-a' } },
          descendants: [],
        },
        {
          // A fork branch nested under a subagent: no `origin`, so untouched.
          session: { header: { id: 'fork-b', cwd: CWD, parentSession: 'sub-a' } },
          descendants: [],
        },
      ],
    },
    { session: { header: { id: 'fork-top', cwd: CWD, parentSession: 'session-x' } }, descendants: [] },
  ]
  for (const id of ['session-x', 'sub-a', 'sub-a1']) await seedSession(PROJECT, id)
  const { ctx, state } = makeContext({ descendants: tree })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.deepEqual(state.traceIds, ['session-x'], 'the trace must be asked about the Session being deleted')
  assert.deepEqual(payload.subagentsRemoved, ['sub-a', 'sub-a1'], 'every subagent descendant must go with its parent, depth-first')
  for (const id of ['session-x', 'sub-a', 'sub-a1']) {
    await assert.rejects(() => stat(join(root, PROJECT, id)), `${id} must be gone`)
  }
  assert.equal(payload.subagentWarnings, undefined, 'a clean cascade must not warn')
  assert.ok(!payload.subagentsRemoved.includes('fork-top'), 'a fork branch is not a subagent and must never be removed with its parent')
  assert.deepEqual(state.emitted, [
    ['api-session/removed', 'sub-a'],
    ['api-session/removed', 'sub-a1'],
    ['api-session/removed', 'session-x'],
  ], 'each removed subagent is announced too, then the parent')
  assert.deepEqual(state.cacheDropped.sort(), ['session-x', 'sub-a', 'sub-a1'].sort(), 'each subagent cache row is dropped')
}

{
  // Regression guard for the bug above: a child whose header names a project
  // directory that does not hold it must be REPORTED, not silently claimed as
  // removed. This is the shape the old code produced for every child (it passed
  // `{ id }`, so `locate` answered `_no-cwd/<id>`), and the response has to say
  // so rather than promise a cascade that did not happen.
  await seedSession(PROJECT, 'session-x')
  const childDir = await seedSession(PROJECT, 'sub-orphan')
  const tree = [{ session: { header: { id: 'sub-orphan', origin: 'subagent', parentSession: 'session-x' } }, descendants: [] }]
  const { ctx, state } = makeContext({ descendants: tree })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.deepEqual(payload.subagentsRemoved, [], 'a child without its cwd must not be reported as removed')
  assert.equal(payload.subagentWarnings.length, 1)
  assert.match(payload.subagentWarnings[0], /sub-orphan/u)
  assert.match(payload.subagentWarnings[0], /\(missing\)/u, 'the report must name the real obstacle')
  assert.equal(await stat(childDir).then(() => true), true, 'the mislocated child stays where it was')

  await rm(childDir, { recursive: true, force: true })
}

{
  // A failing subagent removal is reported but never blocks the parent or the
  // remaining subagents.
  await seedSession(PROJECT, 'session-x')
  await seedSession(PROJECT, 'sub-ok')
  const tree = [
    { session: { header: { id: 'sub-missing', cwd: CWD, origin: 'subagent' } }, descendants: [] },
    { session: { header: { id: 'sub-ok', cwd: CWD, origin: 'subagent' } }, descendants: [] },
  ]
  const { ctx, state } = makeContext({ descendants: tree })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200, 'a subagent that cannot be removed must not fail the parent deletion')
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.subagentsRemoved, ['sub-ok'])
  assert.equal(payload.subagentWarnings.length, 1)
  assert.match(payload.subagentWarnings[0], /sub-missing/u)
  assert.equal(payload.announced, true)
  await assert.rejects(() => stat(join(root, PROJECT, 'sub-ok')))
}

{
  // A subagent held by the Host does NOT stop its removal: the parent's cascade
  // deletes it like any other child. Being live is a report, not a veto — for
  // children as much as for the parent — because otherwise a Host that holds
  // every child would strand them all with the parent gone.
  await seedSession(PROJECT, 'session-x')
  const childDir = await seedSession(PROJECT, 'sub-live')
  const tree = [{ session: { header: { id: 'sub-live', cwd: CWD, origin: 'subagent', parentSession: 'session-x' } }, descendants: [] }]
  const { ctx, state } = makeContext({ descendants: tree })
  const liveSessions = { get: (id) => (id === 'sub-live' ? { id } : undefined) }
  const baseGet = ctx.get
  ctx.get = (key) => (key === 'sessions' ? liveSessions : baseGet(key))
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.deepEqual(payload.subagentsRemoved, ['sub-live'], 'a live child still goes with its parent')
  assert.equal(payload.subagentWarnings, undefined, 'and is not reported as a failure')
  assert.equal(await stat(childDir).then(() => true, () => false), false, 'the child artifact must be gone')
}

{
  // A child with work in flight is the case that still refuses to touch it.
  await seedSession(PROJECT, 'session-x')
  const childDir = await seedSession(PROJECT, 'sub-busy')
  const tree = [{ session: { header: { id: 'sub-busy', cwd: CWD, origin: 'subagent', parentSession: 'session-x' } }, descendants: [] }]
  const { ctx, state } = makeContext({ descendants: tree })
  const baseWaterfall = ctx.waterfall
  ctx.waterfall = async (event, request, next) =>
    request.sessionId === 'sub-busy' ? [{ kind: 'job', items: [{ id: 'job-1' }] }] : baseWaterfall(event, request, next)
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.deepEqual(payload.subagentsRemoved, [], 'a running child must not be deleted under its writer')
  assert.equal(payload.subagentWarnings.length, 1)
  assert.match(payload.subagentWarnings[0], /sub-busy: artifact not removed \(running\)/u)
  assert.equal(await stat(childDir).then(() => true), true, 'the running child survives')

  await rm(childDir, { recursive: true, force: true })
}

{
  // The preview route is read-only and reports the blast radius.
  await seedSession(PROJECT, 'session-x')
  const tree = [
    { session: { header: { id: 'sub-a', cwd: CWD, origin: 'subagent' } }, descendants: [] },
    { session: { header: { id: 'fork-top', cwd: CWD, parentSession: 'session-x' } }, descendants: [] },
  ]
  const { ctx, state } = makeContext({ descendants: tree })
  host.apply(ctx)

  const { status, payload } = await post(state.previewRoute, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.deepEqual(payload.subagentIds, ['sub-a'], 'the preview counts subagents only, not fork branches')
  assert.equal(payload.live, false, 'a cold Session previews as not live')
  assert.equal(
    await stat(join(root, PROJECT, 'session-x')).then(() => true, () => false),
    true,
    'the preview must not delete anything',
  )
  assert.deepEqual(state.emitted, [], 'the preview must not announce a removal')
}

{
  // The preview reports liveness so the dialog can warn BEFORE the user
  // confirms: since it no longer blocks the delete, warning afterwards would be
  // the only notice, and the row coming back would be a surprise.
  await seedSession(PROJECT, 'session-live')
  const { ctx, state } = makeContext({ live: true })
  host.apply(ctx)

  const { status, payload } = await post(state.previewRoute, { sessionId: 'session-live' })
  assert.equal(status, 200)
  assert.equal(payload.live, true, 'the preview must report that the Host holds the Session')
  assert.equal(payload.liveSource, 'sessions')
  assert.equal(await stat(join(root, PROJECT, 'session-live')).then(() => true, () => false), true, 'the preview stays read-only')
}

/* ------------------- a row whose artifact is gone must still be dismissable */

{
  // Regression: a sidebar row whose Session is no longer in storage used to
  // return `not-found` forever, so the row could never be removed through the
  // UI — the exact dead end a user hit. It is now idempotent: the request
  // succeeds and finishes the bookkeeping, which is what drops the row.
  const { ctx, state } = makeContext()
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-missing' })
  assert.equal(status, 200, 'an already-gone Session is a success, not a dead end')
  assert.equal(payload.ok, true)
  assert.equal(payload.alreadyGone, true)
  assert.equal(payload.artifactRemoved, false, 'nothing was left to remove')
  assert.equal(payload.announced, true, 'the removal must still be announced so the row disappears')
  assert.equal(payload.liveInMemory, false, 'an unknown id is not held by the live store')
  assert.deepEqual(state.emitted, [['api-session/removed', 'session-missing']])
  assert.deepEqual(state.cacheDropped, ['session-missing'], 'a stale cache row is still dropped')
}

{
  // A row whose artifact is gone but whose Session is still held live is the
  // harder case: `listSessions` unions live sessions with persisted ones, so
  // the row can return after a reconnect. The response must say which case it
  // was so a report is answerable instead of a guess.
  const { ctx, state } = makeContext({ live: true })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-zombie' })
  assert.equal(status, 200)
  assert.equal(payload.alreadyGone, true)
  assert.equal(payload.liveInMemory, true, 'a live-but-unpersisted Session must be flagged')
  assert.equal(payload.announced, true)
}

{
  // The preview describes an already-gone Session as empty instead of failing,
  // so the confirmation dialog opens consistently.
  const { ctx, state } = makeContext()
  host.apply(ctx)

  const { status, payload } = await post(state.previewRoute, { sessionId: 'session-missing' })
  assert.equal(status, 200)
  assert.deepEqual(payload.subagentIds, [])
  assert.equal(payload.alreadyGone, true)
}

/* --------------------------- partial cleanup is never an error, never silent */

{
  // The artifact is gone but the workspace detach throws. That must stay a
  // success: the Session really is deleted, and failing the request is what
  // leaves the client holding a phantom row for a Session that is gone.
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext({ failDetach: true })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200, 'a cleanup failure must not turn a real deletion into an error')
  assert.equal(payload.ok, true)
  assert.equal(payload.artifactRemoved, true)
  assert.equal(payload.announced, true, 'the removal must be announced whatever cleanup did')
  assert.deepEqual(payload.detachedFrom, [], 'a failed detach is not a released account slot')
  assert.equal(payload.cleanupWarnings.length, 1, 'the cleanup failure must still be reported')
  assert.match(payload.cleanupWarnings[0], /detach ws-1/u)
  assert.deepEqual(state.emitted, [['api-session/removed', 'session-x']])
  await assert.rejects(() => stat(dir), 'the artifact must be gone')
}

{
  // An unpin that throws must not stop unarchive/detach from running, and must
  // not stop the removal from being announced.
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext({ failUnpin: true })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.equal(payload.announced, true)
  assert.deepEqual(state.unarchived, ['session-x'], 'a failed unpin must not skip unarchive')
  assert.deepEqual(state.detached, ['session-x'], 'a failed unpin must not skip detach')
  assert.deepEqual(payload.detachedFrom, ['ws-1'], 'detachedFrom must carry the workspace entity id')
  assert.match(payload.cleanupWarnings[0], /^unpin:/u)
  await rm(dir, { recursive: true, force: true })
}

{
  // `KvTableImpl.delete` resolves `false` when the key is absent, so
  // `cacheRowDropped` has to report what really happened instead of a constant
  // `true` — that field is the only way to answer "did the cache row go away?".
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext({ cacheDeleteReturns: false })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200, 'an absent cache row is not a failure')
  assert.equal(payload.cacheRowDropped, false, 'an absent cache row must be reported as not dropped')
  await rm(dir, { recursive: true, force: true })
}

{
  // The workspace release must not depend on `Workspace.sessionIds`, which is a
  // FILTERED getter over an in-memory index the plugin does not control: a
  // re-index between the `rm` and the release can hide the id while the durable
  // record still accounts for it. The release is unconditional; the filtered
  // getter only decides what the response reports.
  const dir = await seedSession(PROJECT, 'session-x')
  const { ctx, state } = makeContext()
  const hidden = {
    id: 'ws-hidden',
    // The getter says "not mine" — the release must happen anyway.
    sessionIds: [],
    async detachSession(id) {
      state.detached.push(id)
    },
  }
  const baseGet = ctx.get
  ctx.get = (key) =>
    key === 'workspaceRegistry'
      ? {
          async unpinSession() {},
          async unarchiveSession() {},
          list: () => [hidden],
        }
      : baseGet(key)
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.deepEqual(state.detached, ['session-x'], 'the release must run even when the filtered getter hides the id')
  assert.deepEqual(payload.detachedFrom, [], 'a workspace that does not list the Session is not reported as detached')
  await rm(dir, { recursive: true, force: true })
}

/* ------------------------------------------- nothing else was removed --- */

{
  const projects = await readdir(root)
  assert.deepEqual(projects, [PROJECT], 'the fake root must still hold only its project directory')
}

await rm(root, { recursive: true, force: true })

console.log('host half: all behavioural checks passed')
