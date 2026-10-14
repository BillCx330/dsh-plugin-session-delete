/**
 * Offline contract test for the Client half.
 *
 * Runs the real `lib/client.js` against a stub module table: it proves the
 * Module Loader registration shape, the two slot registrations (id, order,
 * locale, seat), the destructive styling on the row, the dialog's host call,
 * and the failure mapping — all without a browser.
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const CLIENT = resolve(import.meta.dirname, '..', 'lib', 'client.js')

/* ---------------------------------------------------------------- stubs --- */

const rendered = []
const elements = []

/* A minimal document, so the stylesheet lifecycle (install once, release on
   teardown) is observable instead of silently skipped. */
const styleTags = []
globalThis.document = {
  head: {
    appendChild(tag) {
      styleTags.push(tag)
    },
  },
  createElement(tagName) {
    return {
      tagName,
      dataset: {},
      textContent: '',
      removed: false,
      remove() {
        this.removed = true
      },
    }
  },
  querySelector(selector) {
    const match = /^style\[data-plugin-css="(.*)"\]$/u.exec(selector)
    if (match === null) return null
    return styleTags.find((tag) => tag.dataset.pluginCss === match[1] && !tag.removed) ?? null
  },
}

function createElement(type, props, ...children) {
  const element = { type, props: props ?? {}, children: children.filter((c) => c !== null && c !== undefined) }
  elements.push(element)
  return element
}

const React = {
  createElement,
  Fragment: Symbol('Fragment'),
  // Effect stub: runs the setup immediately and ignores the teardown. Enough to
  // exercise components that fetch on mount.
  useEffect(effect) {
    effect()
  },
  useState(initial) {
    const slot = React.__cursor ?? 0
    React.__cursor = slot + 1
    const store = (React.__state ??= [])
    if (!(slot in store)) store[slot] = initial
    return [store[slot], (next) => {
      store[slot] = typeof next === 'function' ? next(store[slot]) : next
    }]
  },
}

function resetHooks() {
  React.__cursor = 0
  React.__state = []
}

const primitiveNames = [
  'Button',
  'IconTrashOutlineRegular',
  'MenuItemButton',
  'Modal',
]
const primitives = Object.fromEntries(primitiveNames.map((name) => [name, name]))

const registrations = []
const localeDictionaries = []
const effects = []

const ctx = {
  effect(callback, label) {
    const dispose = callback()
    effects.push({ label, dispose: typeof dispose === 'function' ? dispose : () => {} })
    return dispose
  },
  locale: {
    register(ns, dicts) {
      localeDictionaries.push({ ns, dicts })
      return () => {}
    },
  },
  slots: {
    inject(key, callback) {
      const effect = callback()
      if (effect && typeof effect[Symbol.iterator] === 'function') {
        for (const disposer of effect) void disposer
      }
      return () => {}
    },
    register(declaration, component) {
      registrations.push({ declaration, component })
      return () => {}
    },
  },
}

/* ------------------------------------------------------------ run bundle --- */

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}

await import(pathToFileURL(CLIENT).href)

assert.ok(registration, 'client.js must register with window.__ModuleLoader__')
assert.equal(registration.id, 'dsh-plugin-session-delete', 'registration id must be the package name')

const requireStub = (specifier) =>
  specifier === 'react' ? React : specifier === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : undefined

const plugin = registration.factory(requireStub)
assert.equal(typeof plugin.apply, 'function', 'client half must export apply')
assert.deepEqual(plugin.inject, ['slots', 'locale'], 'client half must inject the slots and locale services')

plugin.apply(ctx)

assert.deepEqual(
  effects.map((entry) => entry.label),
  ['session-delete: styles', 'session-delete: dictionaries'],
  'apply must own the stylesheet effect and the locale effect',
)

/* ------------------------------------------------------- stylesheet --- */

assert.equal(styleTags.length, 1, 'apply must install its stylesheet once')
assert.equal(styleTags[0].dataset.plugin, 'dsh-plugin-session-delete')
// The module system strips a plugin's owned styles on the code-replacement
// path only; disabling a plugin leaves them in the document unless the plugin
// releases them itself.
effects[0].dispose()
assert.equal(styleTags[0].removed, true, 'the stylesheet effect must release the tag on teardown')

assert.deepEqual(
  localeDictionaries.map((entry) => entry.ns),
  ['session-delete'],
  'the package must register its own locale namespace',
)
for (const locale of ['en', 'zh']) {
  assert.ok(localeDictionaries[0].dicts[locale], `locale dictionary "${locale}" must be present`)
  assert.ok(localeDictionaries[0].dicts[locale]['menu.deleteSession'], `"${locale}" must name the menu row`)
}

assert.equal(registrations.length, 2, 'apply must register exactly the menu row and the dialog')

const menu = registrations.find((r) => r.declaration.name === 'sidebar.workspaces.session.menu.item')
const overlay = registrations.find((r) => r.declaration.name === 'shell.overlay')
assert.ok(menu, 'the Session "..." menu seat must be filled')
assert.ok(overlay, 'the confirmation dialog must live in the shell overlay')

assert.equal(menu.declaration.id, 'session-delete')
assert.equal(menu.declaration.order, 500, 'order 500 places the row after the shipped Archive (400)')
assert.equal(menu.declaration.locale, 'session-delete')

/* ------------------------------------------------------- the menu row --- */

const face = menu.declaration.inject()
assert.equal(typeof face.requestSessionDelete, 'function')
assert.equal(typeof face.settleSessionDelete, 'function')
assert.equal(typeof face.deleteSession, 'function')
assert.ok(face.hooks.deletePending, 'the pending request must be projected as a hook')

let menuOpen = true
resetHooks()
const rowElement = menu.component({
  sessionId: 'session-abc',
  displayTitle: 'A title',
  useMenuOpenState: () => [null, (next) => { menuOpen = next }],
  requestSessionDelete: face.requestSessionDelete,
  t: (key) => key,
})

assert.equal(rowElement.type, 'MenuItemButton')
assert.equal(rowElement.props.danger, true, 'the row must use the destructive (red) variant')
assert.equal(rowElement.props.separatorBefore, true, 'the row must open its own group')
assert.equal(rowElement.props.icon.type, 'IconTrashOutlineRegular', 'the row needs the trash glyph')
assert.deepEqual(rowElement.children, ['menu.deleteSession'])

rowElement.props.onSelect()
assert.equal(menuOpen, false, 'activating the row must dismiss the menu')
assert.deepEqual(
  face.hooks.deletePending.getSnapshot(),
  { sessionId: 'session-abc', displayTitle: 'A title' },
  'activating the row must raise the pending request',
)

/* --------------------------------------------------------- the dialog --- */

// A preview reporting two subagent sessions, so the dialog's blast-radius note
// has something real to render.
const previewIds = ['sub-1', 'sub-2']
const previewCalls = []
const facePreview = async (sessionId) => {
  previewCalls.push(sessionId)
  return previewIds
}

resetHooks()
const dialogElement = overlay.component({
  useDeletePending: (selector) => selector(face.hooks.deletePending.getSnapshot()),
  settleSessionDelete: face.settleSessionDelete,
  deleteSession: face.deleteSession,
  preview: facePreview,
  t: (key) => key,
})

// The overlay entry renders one keyed inner form per request.
assert.equal(dialogElement.type.name, 'DeleteSessionForm')
assert.equal(dialogElement.props.request.sessionId, 'session-abc')

resetHooks()
const modalElement = dialogElement.type(dialogElement.props)

// The preview resolves after mount, so the note appears on the render that
// follows it. Real React re-renders on the state change; here we re-render
// with the same hook state and assert against that.
await new Promise((resolve) => setTimeout(resolve, 0))
React.__cursor = 0
const modalWithPreview = dialogElement.type(dialogElement.props)

assert.equal(modalElement.type, 'Modal')
assert.equal(modalElement.props.open, true)
assert.equal(modalElement.props.title, 'dialog.title')

// The blast radius is described before anything is destroyed: subagent count
// (hidden from the sidebar by `origin: 'subagent'`) and a note that fork
// branches survive as independent sessions.
// The preview is asked for the request's session. The effect keys on
// `request.sessionId`, so re-rendering the same request does not re-query it
// in real React; the test's `useEffect` stub re-runs on every render, hence
// the "at least once" rather than "exactly once" assertion.
assert.ok(previewCalls.length >= 1, 'the preview must be asked for the request')
assert.ok(previewCalls.every((id) => id === 'session-abc'), 'the preview must only ever be asked about the request session')
const noteKeys = modalWithPreview.props.children
  .filter((child) => child !== null && child !== undefined)
  .map((child) => child.props.key)
assert.ok(noteKeys.includes('subagents'), 'the subagent blast-radius note must render when there are subagents')
assert.ok(noteKeys.includes('forks'), 'the fork-survival note must always render')
const subagentNote = modalWithPreview.props.children.find((child) => child !== null && child.props?.key === 'subagents')
assert.equal(subagentNote.props.role, 'note')

const footer = modalElement.props.footer
assert.equal(footer.type, React.Fragment)
const [cancel, confirm] = footer.children
assert.equal(cancel.type, 'Button')
assert.equal(confirm.type, 'Button')
assert.equal(confirm.props.className, 'dsh-session-delete-action', 'the confirm action must carry the red class')
assert.equal(confirm.props.children, 'dialog.confirm')

/* ------------------------------------------------------ host round trip --- */

const calls = []
globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, sessionId: 'session-abc' }),
  }
}

let settled = false
resetHooks()
const formElement = dialogElement.type({
  ...dialogElement.props,
  settleSessionDelete: () => {
    settled = true
    face.settleSessionDelete()
  },
})

const confirmAction = formElement.props.footer.children[1]
await confirmAction.props.onClick()
await new Promise((r) => setTimeout(r, 0))

assert.equal(calls.length, 1, 'confirming must issue exactly one Host call')
assert.equal(calls[0].url, '/api/session.delete')
assert.equal(calls[0].init.method, 'POST')
assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 'session-abc' })
assert.equal(settled, true, 'a successful deletion must settle the pending request')
assert.equal(face.hooks.deletePending.getSnapshot(), null)

/* ------------------------------------------------ Host failure mapping --- */

// The REAL preview hop must be exercised, not only stubbed: it reads the
// non-destructive route, and returning `[]` when the Host could not be asked
// would tell the user there is no blast radius at the one moment they decide to
// act. A copy/paste of the delete route in here would delete a Session the
// instant the dialog opened, so the URL is asserted too.
{
  const previewCalls = []
  globalThis.fetch = async (url, init) => {
    previewCalls.push({ url, init })
    return { ok: true, json: async () => ({ ok: true, subagentIds: ['a', 'b'] }) }
  }

  assert.deepEqual(await face.preview('session-abc'), ['a', 'b'], 'the real preview hop must return the ids')
  assert.equal(previewCalls.length, 1)
  assert.equal(previewCalls[0].url, '/api/session.delete.preview', 'the preview must never call the destructive route')
  assert.equal(previewCalls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(previewCalls[0].init.body), { sessionId: 'session-abc' })

  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, code: 'failed' }),
  })
  assert.equal(await face.preview('session-abc'), null, 'a Host failure must read as "unknown", not "none"')

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
  assert.equal(await face.preview('session-abc'), null, 'a payload without subagentIds must read as "unknown"')

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => {
      throw new Error('not json')
    },
  })
  assert.equal(await face.preview('session-abc'), null, 'an unreadable body must read as "unknown"')

  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  assert.equal(await face.preview('session-abc'), null, 'an unreachable Host must read as "unknown"')
}

globalThis.fetch = async () => ({
  ok: false,
  status: 409,
  json: async () => ({ ok: false, code: 'running', message: 'busy' }),
})

await assert.rejects(() => face.deleteSession('session-abc'), (error) => error.code === 'running')

globalThis.fetch = async () => {
  throw new Error('offline')
}
await assert.rejects(() => face.deleteSession('session-abc'), (error) => error.code === 'network')

/* ------------------------- unknown failure codes degrade to a sentence --- */

// A Host that grows new failure codes must never leave a raw `error.<code>`
// key in the dialog. The test's `t` returns its own key, so a known code
// renders `error.<code>` while an unmapped one must fall back to the generic
// message instead of leaking the key.
const renderForm = () => {
  const element = overlay.component({
    useDeletePending: (selector) => selector(face.hooks.deletePending.getSnapshot()),
    settleSessionDelete: face.settleSessionDelete,
    deleteSession: face.deleteSession,
    preview: facePreview,
    t: (key) => key,
  })
  return element === null ? null : element.type(element.props)
}

for (const [code, expected] of [
  ['live', 'error.live'],
  ['running', 'error.running'],
  ['brand-new-failure-code', 'error.failed'],
]) {
  face.requestSessionDelete('session-abc', 'A title')
  resetHooks()
  let form = renderForm()
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, code }),
  })
  await form.props.footer.children[1].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  // Re-render with the same hook state (only the call cursor resets) so the
  // error written by the first render is the one this render displays.
  React.__cursor = 0
  form = renderForm()
  const errorNode = form.props.children.find((child) => child !== null && child.props?.key === 'error')
  assert.ok(errorNode, `an error row must render for code "${code}"`)
  assert.equal(errorNode.children[0], expected, `failure code "${code}" must render "${expected}"`)
  face.settleSessionDelete()
}

/* ------------------- a partial result is reported, not silently dropped --- */

// The deletion really happened, but the Host reported things the user has to
// know: a subagent that could not be removed, and a live Session whose row can
// come back. Closing the dialog on top of those is what made the cascade bug
// invisible; the form must stay open on the report until the user closes it.
{
  const localized = []
  const t = (key, params) => {
    localized.push([key, params])
    return key
  }
  const render = (deleteSession, preview) => {
    const element = overlay.component({
      useDeletePending: (selector) => selector(face.hooks.deletePending.getSnapshot()),
      settleSessionDelete: () => {
        settledCount += 1
        face.settleSessionDelete()
      },
      deleteSession,
      preview,
      t,
    })
    return element === null ? null : element.type(element.props)
  }

  let settledCount = 0
  const deleteSession = async () => ({
    ok: true,
    sessionId: 'session-warn',
    artifactRemoved: true,
    subagentWarnings: ['sub-x: artifact not removed (live)'],
    liveInMemory: true,
  })

  face.requestSessionDelete('session-warn', 'A title')
  resetHooks()
  let form = render(deleteSession, async () => [])
  await form.props.footer.children[1].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  React.__cursor = 0
  form = render(deleteSession, async () => [])

  assert.equal(settledCount, 0, 'a reported partial result must keep the dialog open')
  assert.equal(form.props.description, 'dialog.deleted', 'the dialog must say the Session is gone')
  assert.equal(form.props.footer.type, 'Button', 'the only action left is Close')
  assert.equal(form.props.footer.props.children, 'dialog.close')

  const warnNode = form.props.children.find((child) => child !== null && child.props?.key === 'warn')
  assert.ok(warnNode, 'the dialog must render the warning block')
  assert.equal(warnNode.props.role, 'alert')
  assert.deepEqual(
    warnNode.children.map((child) => child.children[0]),
    ['dialog.warnTitle', 'dialog.warn.subagents', 'dialog.warn.live'],
    'every reported problem must get its own localized line',
  )
  assert.deepEqual(
    localized.filter(([key]) => key === 'dialog.warn.subagents'),
    [['dialog.warn.subagents', { detail: 'sub-x: artifact not removed (live)' }]],
    'the child id must reach the localized sentence',
  )

  form.props.footer.props.onClick()
  assert.equal(settledCount, 1, 'closing must settle the request')
  assert.equal(face.hooks.deletePending.getSnapshot(), null)
}

/* ------------------- an unaskable preview is not "no subagents" --- */

{
  face.requestSessionDelete('session-nopreview', 'A title')
  resetHooks()
  const render = (preview) => {
    const element = overlay.component({
      useDeletePending: (selector) => selector(face.hooks.deletePending.getSnapshot()),
      settleSessionDelete: face.settleSessionDelete,
      deleteSession: async () => ({ ok: true }),
      preview,
      t: (key) => key,
    })
    return element === null ? null : element.type(element.props)
  }

  let form = render(async () => null)
  await new Promise((resolve) => setTimeout(resolve, 0))
  React.__cursor = 0
  form = render(async () => null)

  const previewNode = form.props.children.find((child) => child !== null && child.props?.key === 'preview')
  assert.ok(previewNode, 'a failed preview must be visible, not rendered as "no subagents"')
  assert.equal(previewNode.children[0], 'dialog.previewUnavailable')
  assert.equal(
    form.props.children.some((child) => child !== null && child.props?.key === 'subagents'),
    false,
    'a failed preview must not claim a blast radius of zero either',
  )
  face.settleSessionDelete()
}

console.log('client half: all contract checks passed')
