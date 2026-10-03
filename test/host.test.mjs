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
function makeContext({ live = false, running = false, locate = true, outsidePath } = {}) {
  const state = {
    deleted: [],
    detached: [],
    unpinned: [],
    unarchived: [],
    emitted: [],
    cacheDropped: [],
    route: undefined,
  }

  const sessions = {
    get: (id) => (live && id === 'session-live' ? { id } : undefined),
  }

  const agents = { get: () => undefined }

  const summaries = [
    { sessionId: 'session-x', running: false },
    { sessionId: 'session-live', running: false },
    { sessionId: 'session-busy', running: true },
  ]
  if (running) summaries.find((s) => s.sessionId === 'session-x').running = true

  const persistence = {
    root,
    async stat(id) {
      if (id === 'session-missing') return undefined
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
      state.unpinned.push(id)
    },
    async unarchiveSession(id) {
      state.unarchived.push(id)
    },
    list: () => [
      {
        workspaceId: 'ws-1',
        sessionIds: ['session-x', 'session-live', 'session-busy'],
        async detachSession(id) {
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
          state.route = route
        },
      },
    },
    emit(event, ...args) {
      state.emitted.push([event, ...args])
    },
    get(key) {
      switch (key) {
        case 'sessions':
          return sessions
        case 'agents':
          return agents
        case 'sessionPersistence':
          return persistence
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
        case 'sessionController':
          return {
            async list() {
              return { items: summaries }
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

  const missing = await post(state.route, { sessionId: 'session-missing' })
  assert.equal(missing.status, 404)
  assert.equal(missing.payload.code, 'not-found')

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
  const dir = await seedSession('--proj--', 'session-live')
  const { ctx, state } = makeContext({ live: true })
  host.apply(ctx)

  const { status, payload } = await post(state.route, { sessionId: 'session-live' })
  assert.equal(status, 409)
  assert.equal(payload.code, 'live')
  await stat(dir)
  assert.deepEqual(state.detached, [])
  await rm(dir, { recursive: true, force: true })
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

/* ------------------------------------------- nothing else was removed --- */

{
  const projects = await readdir(root)
  assert.deepEqual(projects, ['--proj--'], 'the fake root must still hold only its project directory')
}

await rm(root, { recursive: true, force: true })

console.log('host half: all behavioural checks passed')
