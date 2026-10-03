/**
 * Package-contract test: the manifest rules the Host's client-module scanner
 * and the Loader actually apply.
 *
 * Mirrors `client-modules`' `resolveMeta` (a `dsh.client` object, `platform:
 * "web"`, and an `exports["./client"]` that resolves to a real file) plus the
 * bundle's own Module Loader registration shape, so a manifest regression fails
 * here instead of silently serving no browser half.
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/* ------------------------------------------------ bundle + client decls --- */

assert.equal(pkg.type, 'module', 'the Host half is ESM')
assert.equal(await stat(join(root, 'lib', 'index.js')).then(() => true), true)

const bundle = pkg.dsh?.bundle
assert.ok(bundle, 'the package must declare dsh.bundle so a profile can compose it')
assert.equal(typeof bundle.patch, 'string', 'dsh.bundle.patch must name the patch file')
await stat(join(root, bundle.patch))

const client = pkg.dsh?.client
assert.ok(client, 'the package must declare dsh.client so the browser half is served')
assert.equal(client.platform, 'web', 'only a web platform declaration is served')
assert.ok(Array.isArray(client.inject), 'dsh.client.inject must be a string array')
for (const name of client.inject) assert.equal(typeof name, 'string')

/* --------------------------------------------------- exports["./client"] --- */

const exportsField = pkg.exports
assert.equal(typeof exportsField, 'object')
const clientExport = exportsField['./client']
const clientRel =
  typeof clientExport === 'string'
    ? clientExport
    : typeof clientExport?.default === 'string'
      ? clientExport.default
      : undefined
assert.ok(clientRel, 'exports["./client"] must be a string or an object with a string default')
await stat(join(root, clientRel))

const mainExport = exportsField['.']?.default
const normalize = (value) => (typeof value === 'string' ? value.replace(/^\.\//u, '') : value)
assert.equal(
  normalize(mainExport),
  normalize(pkg.main),
  'the "." export must name the same entry as main',
)

/* -------------------------------------------------- patch inserts this row --- */

const patch = await readFile(join(root, bundle.patch), 'utf8')
assert.match(patch, /insert:/u, 'the patch must be an insert list')
assert.match(
  patch,
  new RegExp(`name:\\s*'${pkg.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'`, 'u'),
  'the patch must insert this package so the scanner can find its manifest',
)

/* --------------------------------------- the bundle is a loader registration */

const bundleSource = await readFile(join(root, clientRel), 'utf8')
assert.match(
  bundleSource,
  /window\.__ModuleLoader__\.load\(\{/u,
  'the browser half must register through window.__ModuleLoader__',
)
assert.match(
  bundleSource,
  new RegExp(`id:\\s*'${pkg.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'`, 'u'),
  'the registration id must be the package name the Host graph keys on',
)
assert.match(bundleSource, /require\('react'\)/u, 'React must come from the module table')
assert.match(
  bundleSource,
  /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/u,
  'the shared primitives are the implicit baseline external',
)

/* ------------------------------------------------- published file set --- */

const files = pkg.files
assert.ok(Array.isArray(files) && files.length > 0, 'the published file set must be declared')
for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
  assert.ok(files.includes(required), `"${required}" must be published`)
}

/* -------------------------------------- no lifecycle scripts / allowBuilds --- */

// A git install runs the package's `prepare`, and pnpm >= 10 refuses to run it
// without an explicit `allowBuilds` grant from the user. This plugin ships
// prebuilt output and declares no lifecycle scripts, so every install route is
// script-free. A regression here would silently change what a user must
// authorize before installing, so it is a contract, not a preference.
const scripts = pkg.scripts ?? {}
for (const forbidden of ['prepare', 'prepack', 'preinstall', 'install', 'postinstall']) {
  assert.equal(scripts[forbidden], undefined, `no "${forbidden}" script: installs must never need an allowBuilds grant`)
}

/* -------------------------------------------------- release metadata --- */

assert.match(pkg.version, /^\d+\.\d+\.\d+$/u, 'the release version must be plain semver')
assert.ok(pkg.repository?.url?.includes('github.com/'), 'repository must name the GitHub repo')
assert.ok(pkg.engines?.dsh, 'engines.dsh lets the market screen for host compatibility')
assert.ok(pkg.license, 'a license must be declared')

console.log('manifest: all package-contract checks passed')
