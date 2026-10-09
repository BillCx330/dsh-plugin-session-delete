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

/** Create one stored session directory under the fake persistence root. */
async function seedSession(project, sessionId) {
  const dir = join(root, project, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'not-a-real-log')
  return dir
}

/** Build a Host context over one fake deployment shape. */
function makeContext({ live = false, running = false, locate = true, outsidePath, failDetach = false, failUnpin = false, descendants = [] } = {}) {
  const state = {
    detached: [],
    unpinned: [],
    unarchived: [],
    emitted: [],
    cacheDropped: [],
    activityQueries: 0,
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
      return { header: { id, cwd: 'C:\\proj', version: 4, createdAt: 0, isSeeded: false } }
    },
    ...(locate
      ? {
          locate(header) {
            if (outsidePath !== undefined) return { kind: 'jsonl', path: outsidePath }
            return { kind: 'jsonl', path: join(root, '--proj--', header.id, 'session.v4.jsonl.zstd') }
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
            // each node a `SessionRecord` with a `header` carrying `origin`.
            async traceSession() {
              return { target: { header: { id: 'session-x' } }, ancestors: [], descendants }
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
  const dir = await seedSession('--proj--', 'session-x')
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
  const dir = await seedSession('--proj--', 'session-x')
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
  // Regression: an attached-but-idle Session MUST still be deletable. The
  // client retains every visible row (`useSessionStatus`), so "attached" is
  // the ordinary state of every row in the sidebar — treating it as a refusal
  // made the plugin refuse every session, which is the bug this test exists
  // to keep fixed. Only reported activity may block a delete.
  const dir = await seedSession('--proj--', 'session-live')
  const { ctx, state } = makeContext({ live: true })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-live' })
  assert.equal(status, 200, 'an attached but idle Session must be deletable')
  assert.equal(payload.ok, true)
  assert.equal(payload.artifactRemoved, true)
  assert.equal(payload.announced, true)
  assert.equal(state.activityQueries > 0, true, 'running work must still be asked about')
  await assert.rejects(() => stat(dir), 'the artifact must be gone')
  assert.deepEqual(state.detached, ['session-live'], 'the workspace slot must be released')
}

{
  const dir = await seedSession('--proj--', 'session-x')
  const { ctx, state } = makeContext({ running: true })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 409)
  assert.equal(payload.code, 'running')
  await stat(dir)
  assert.deepEqual(state.detached, [])
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
  const tree = [
    {
      session: { header: { id: 'sub-a', origin: 'subagent', parentSession: 'session-x' } },
      descendants: [
        {
          session: { header: { id: 'sub-a1', origin: 'subagent', parentSession: 'sub-a' } },
          descendants: [],
        },
        {
          // A fork branch nested under a subagent: no `origin`, so untouched.
          session: { header: { id: 'fork-b', parentSession: 'sub-a' } },
          descendants: [],
        },
      ],
    },
    { session: { header: { id: 'fork-top', parentSession: 'session-x' } }, descendants: [] },
  ]
  for (const id of ['session-x', 'sub-a', 'sub-a1']) await seedSession('--proj--', id)
  const { ctx, state } = makeContext({ descendants: tree })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.deepEqual(payload.subagentsRemoved, ['sub-a', 'sub-a1'], 'every subagent descendant must go with its parent, depth-first')
  for (const id of ['session-x', 'sub-a', 'sub-a1']) {
    await assert.rejects(() => stat(join(root, '--proj--', id)), `${id} must be gone`)
  }
  assert.ok(!payload.subagentsRemoved.includes('fork-top'), 'a fork branch is not a subagent and must never be removed with its parent')
  assert.deepEqual(state.emitted, [
    ['api-session/removed', 'sub-a'],
    ['api-session/removed', 'sub-a1'],
    ['api-session/removed', 'session-x'],
  ], 'each removed subagent is announced too, then the parent')
  assert.deepEqual(state.cacheDropped.sort(), ['session-x', 'sub-a', 'sub-a1'].sort(), 'each subagent cache row is dropped')
}

{
  // A failing subagent removal is reported but never blocks the parent or the
  // remaining subagents.
  await seedSession('--proj--', 'session-x')
  await seedSession('--proj--', 'sub-ok')
  const tree = [
    { session: { header: { id: 'sub-missing', origin: 'subagent' } }, descendants: [] },
    { session: { header: { id: 'sub-ok', origin: 'subagent' } }, descendants: [] },
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
  await assert.rejects(() => stat(join(root, '--proj--', 'sub-ok')))
}

{
  // The preview route is read-only and reports the blast radius.
  await seedSession('--proj--', 'session-x')
  const tree = [
    { session: { header: { id: 'sub-a', origin: 'subagent' } }, descendants: [] },
    { session: { header: { id: 'fork-top', parentSession: 'session-x' } }, descendants: [] },
  ]
  const { ctx, state } = makeContext({ descendants: tree })
  host.apply(ctx)

  const { status, payload } = await post(state.previewRoute, { sessionId: 'session-x' })
  assert.equal(status, 200)
  assert.deepEqual(payload.subagentIds, ['sub-a'], 'the preview counts subagents only, not fork branches')
  assert.equal(
    await stat(join(root, '--proj--', 'session-x')).then(() => true, () => false),
    true,
    'the preview must not delete anything',
  )
  assert.deepEqual(state.emitted, [], 'the preview must not announce a removal')
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
  const dir = await seedSession('--proj--', 'session-x')
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
  const dir = await seedSession('--proj--', 'session-x')
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
  // The active-work probe is the shipped one, and a reported job blocks the
  // delete before anything is touched.
  const dir = await seedSession('--proj--', 'session-x')
  const { ctx, state } = makeContext({ running: true })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-x' })
  assert.equal(status, 409)
  assert.equal(payload.code, 'running')
  assert.equal(state.activityQueries > 0, true, 'the shipped activity probe must be asked')
  await stat(dir)
  assert.deepEqual(state.detached, [])
  assert.deepEqual(state.emitted, [])
  await rm(dir, { recursive: true, force: true })
}

/* ------------------------------------------- nothing else was removed --- */

{
  const projects = await readdir(root)
  assert.deepEqual(projects, ['--proj--'], 'the fake root must still hold only its project directory')
}

await rm(root, { recursive: true, force: true })

console.log('host half: all behavioural checks passed')
