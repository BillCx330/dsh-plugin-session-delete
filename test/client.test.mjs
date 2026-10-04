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

function createElement(type, props, ...children) {
  const element = { type, props: props ?? {}, children: children.filter((c) => c !== null && c !== undefined) }
  elements.push(element)
  return element
}

const React = {
  createElement,
  Fragment: Symbol('Fragment'),
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
    effects.push(label)
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
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

assert.equal(effects.length, 1, 'apply must own exactly one locale effect')

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

resetHooks()
const dialogElement = overlay.component({
  useDeletePending: (selector) => selector(face.hooks.deletePending.getSnapshot()),
  settleSessionDelete: face.settleSessionDelete,
  deleteSession: face.deleteSession,
  t: (key) => key,
})

// The overlay entry renders one keyed inner form per request.
assert.equal(dialogElement.type.name, 'DeleteSessionForm')
assert.equal(dialogElement.props.request.sessionId, 'session-abc')

resetHooks()
const modalElement = dialogElement.type(dialogElement.props)

assert.equal(modalElement.type, 'Modal')
assert.equal(modalElement.props.open, true)
assert.equal(modalElement.props.title, 'dialog.title')

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

globalThis.fetch = async () => ({
  ok: false,
  status: 409,
  json: async () => ({ ok: false, code: 'live', message: 'open' }),
})

await assert.rejects(() => face.deleteSession('session-abc'), (error) => error.code === 'live')

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
    t: (key) => key,
  })
  return element === null ? null : element.type(element.props)
}

for (const [code, expected] of [
  ['live', 'error.live'],
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

console.log('client half: all contract checks passed')
