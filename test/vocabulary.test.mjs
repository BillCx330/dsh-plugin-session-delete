/**
 * Vocabulary contract test: the failure codes and locale keys this package
 * publishes must describe ONE set of names across five surfaces.
 *
 *   1. the Host's runtime `SESSION_DELETE_CODES`
 *   2. `lib/types/index.d.ts` (the published Host type)
 *   3. the Client bundle's runtime `zh` dictionary
 *   4. the Client bundle's runtime `en` dictionary
 *   5. `lib/types/client/index.d.ts` (the published locale namespace keys)
 *
 * The Client's `KNOWN_FAILURE_CODES` is derived from (3)/(4) at runtime, so it
 * is covered by them. Drift between these surfaces is invisible at runtime — a
 * code with no dictionary entry degrades to a generic sentence, a declared key
 * with no code is dead copy — which is exactly why it needs a test rather than
 * a review.
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')

const host = await import(new URL('../lib/index.js', import.meta.url).href)

/* ------------------------------------------------- runtime client bundle --- */

const dictionaries = []
let clientPlugin
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      const plugin = value.factory((specifier) =>
        specifier === 'react' ? { createElement: () => null, Fragment: null, useEffect() {}, useState: () => [null, () => {}] } : {},
      )
      clientPlugin = plugin
      plugin.apply({
        effect(callback) {
          const dispose = callback()
          return typeof dispose === 'function' ? dispose : () => {}
        },
        locale: {
          register(ns, dicts) {
            dictionaries.push({ ns, dicts })
            return () => {}
          },
        },
        slots: {
          inject() {
            return () => {}
          },
          register() {
            return () => {}
          },
        },
      })
    },
  },
}

await import(pathToFileURL(resolve(ROOT, 'lib', 'client.js')).href)
assert.equal(dictionaries.length, 1, 'the Client half must register exactly one namespace')
const runtimeKeys = { en: Object.keys(dictionaries[0].dicts.en), zh: Object.keys(dictionaries[0].dicts.zh) }

/* ------------------------------------------------------ published types --- */

const hostTypes = await readFile(resolve(ROOT, 'lib', 'types', 'index.d.ts'), 'utf8')
const declaredCodes = (() => {
  const match = /SESSION_DELETE_CODES:\s*readonly\s*\[([\s\S]*?)\]/u.exec(hostTypes)
  assert.ok(match, 'lib/types/index.d.ts must declare SESSION_DELETE_CODES')
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1])
})()

const clientTypes = await readFile(resolve(ROOT, 'lib', 'types', 'client', 'index.d.ts'), 'utf8')
const declaredKeys = (() => {
  const match = /interface LocaleNamespaceMap\s*\{([\s\S]*?)\n\}/u.exec(clientTypes)
  assert.ok(match, 'lib/types/client/index.d.ts must declare LocaleNamespaceMap')
  assert.match(match[1], /'session-delete'\s*:/u, 'the declared map must key the namespace the Client registers')
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]).filter((key) => key !== 'session-delete')
})()

/* ------------------------------------------------------------ assertions --- */

assert.deepEqual(
  declaredCodes,
  [...host.SESSION_DELETE_CODES],
  'the declared Host failure codes must match the runtime array exactly, order included',
)

assert.deepEqual(runtimeKeys.zh, runtimeKeys.en, 'both dictionaries must carry the same keys, order included')
assert.deepEqual(declaredKeys, runtimeKeys.en, 'the declared locale keys must match the dictionaries exactly')
assert.equal(clientPlugin.NS, 'session-delete', 'the namespace the Client registers must be the declared one')
assert.deepEqual(dictionaries[0].ns, clientPlugin.NS, 'the registered dictionary must live under that namespace')

// The Client synthesizes `network` (unreachable Host) and `timeout` (the Host
// did not answer in time) itself, so they are the two `error.*` keys that are
// deliberately NOT Host codes.
const CLIENT_CODES = new Set(['network', 'timeout'])
const hostCodes = new Set(host.SESSION_DELETE_CODES)
for (const key of runtimeKeys.en) {
  if (!key.startsWith('error.')) continue
  const code = key.slice('error.'.length)
  if (CLIENT_CODES.has(code)) {
    assert.ok(!hostCodes.has(code), `error.${code} is Client-synthesized and must not be a Host code`)
    continue
  }
  assert.ok(hostCodes.has(code), `"${key}" must name a code the Host can actually return`)
}
for (const code of hostCodes) {
  assert.ok(runtimeKeys.en.includes(`error.${code}`), `the Host code "${code}" must have a dictionary entry`)
}

console.log('vocabulary: all surfaces agree')
