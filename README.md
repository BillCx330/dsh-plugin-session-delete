# dsh-plugin-session-delete

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/dsh-plugin-8b5cf6.svg)](https://github.com/deepseek-ai/deepseek-harness)

English | [中文](README.zh.md)

Adds a **Delete session** row at the **bottom** of a Session's "⋯" menu. The label and the trash glyph use DSH's own destructive (red) colors, and the row opens a confirmation dialog; confirming removes the session **permanently from disk**.

```sh
dsh plugin --profile web add github:BillCx330/dsh-plugin-session-delete
```

---

## What it contributes

| | |
|---|---|
| Slot | `sidebar.workspaces.session.menu.item` |
| Row id | `session-delete` |
| Order | `order: 500` — after the shipped `pin` (100), `rename` (200), `fork` (300), and `archive` (400), i.e. the bottom of the menu |
| Grouping | `separatorBefore` — the same hairline the shipped rows use, so the row opens its own group |
| Colors | `MenuItemButton`'s `danger` prop → label and icon both `--dsw-alias-state-error-primary` (red), hover fill `--dsw-alias-interactive-bg-hover-danger` |
| Icon | `IconTrashOutlineRegular` |
| Confirmation | A `Modal` in `shell.overlay`, whose confirm action reuses the shipped `--dsw-alias-state-error-primary` red |

**Consistent with the original style**: the row reuses `ui-primitives`' `MenuItemButton` directly — geometry, hover fill, focus ring, keyboard walk, and post-selection focus return are all the shipped component's. The red is not a hand-picked value either; it is DSH's own destructive semantic color.

## Why a plugin is needed

DSH ships **no** session deletion, and says so:

> **No Session deletion** — sessions can be archived but never deleted.
> — `@deepseek-ai/dsh-client-ui-workspace` README

The Host exposes no delete verb either: `sessionPersistence` has only `create` / `open` / `flush` / `stat` / `list`, and `sessionQuery` has only read methods. This plugin therefore composes deletion as one ordered operation.

## How deletion is carried out

The Host half runs these steps in order; any failure aborts and returns a localizable code:

1. **Read the stored header** — `sessionPersistence.stat(sessionId)`; absent → `not-found`.
2. **Refuse an attached session** — a session present in `sessions` / `agents`, or reported `running` by `sessionController.list()`, returns `live` / `running`.
   An open session must be refused rather than force-deleted: the append-only writer still holds the artifact (on Windows an open file cannot be removed at all), and the loop would keep committing events into a directory that no longer exists. Archive or navigate away first.
3. **Remove the durable artifact** — the persistence backend names its own path (`locate(header)`); the whole session directory (every `session.vN.jsonl.zst` generation) is removed. Without `locate`, the fallback scans two levels under the configured root for a directory whose name is exactly the session id.
   **The artifact goes first, and nothing else is touched until it is confirmed gone**, so every later step only finishes a deletion that already happened and a failure can never leave a half-removed session.
4. **Release the workspace account slot** — `workspaceRegistry`: `unpinSession`, `unarchiveSession`, then `detachSession` on every `Workspace` that accounts for it, removing the session from `workspace.json` for real.
5. **Drop the projection-cache row** — through the domain that owns it, so the in-memory table and the durable file stay coherent, rather than deleting the medium directly: `storageDomain.get('session_projcache').table('sessions').delete(id)`.
6. **Announce the removal** — `ctx.emit('api-session/removed', sessionId)`.

### Why step 6 is required

A client's sidebar list only ever **grows** from the `api-session/added` event; it is otherwise rebuilt in full on reconnect (`handleConnected` → `refreshList`). So a session deleted on the Host keeps a row in the browser — a row that cannot be opened.

Ungrouped is derived as `list.ids.filter(id => !accounted.has(id))` — sessions the list holds that no Workspace accounts for. Step 4's detach therefore moves the phantom row out of its workspace group and **into Ungrouped**, where opening it fails with `session/not-found`.

`api-session/removed` is the shipped signal for exactly this: `api-session-controller` emits it when a session is disposed, `api-remotes` forwards it (it is on that package's forwarded-event allowlist), and the client's session-controller drops the row on receipt. Step 6 makes the row disappear **immediately**, with no page reload.

> If your sidebar still holds sessions deleted by version 1.0.0 (which the Host no longer has), **one page reload** clears them: the reconnect refresh discards identities absent from the baseline (`mergeOrderedBaseline`: *identities absent from the baseline are removed*).

### Safety guard

Removal is the one irreversible step, so the target is proven before it is touched; failing any clause is **reported, never deleted**:

- the path must be absolute;
- its final segment must be exactly the requested session id;
- it must sit strictly inside the persistence root.

When the guard refuses, the request fails and **nothing else changes**: workspace accounting, projection cache, and the client's list all stay as they were.

The route also rejects any session id containing `/`, `\`, or NUL.

### What survives a deletion

The `session-query-sqlite` full-text index briefly keeps a row for the session, but it is not user-visible: the Host-side session search first computes its visible id set from `sessionQuery.listSessions()` (which reads `sessionPersistence.list()` directly) and filters results by it, and the index itself reconciles the row away (`persistentDeletes`) on its next search.

## Layout

```
dsh-plugin-session-delete/
├── package.json          # dsh.bundle.patch + dsh.client (inject / platform)
├── cordis.patch.yml      # inserts this package's own Host half as a loader row
├── icon.svg
├── lib/
│   ├── index.js          # Host half: the /api/session.delete route and storage cleanup
│   ├── client.js         # Client half: Module Loader package (menu row + confirmation)
│   └── types/            # .d.ts
└── test/
    ├── host.test.mjs     # real-fs deletion, every refusal path, the path guard
    └── client.test.mjs   # registration shape, slot declarations, danger prop, host call
```

## Install

Pick one. They all end the same way: restart DSH, then refresh the page.

**Plugin market** (recommended) — Settings → Plugins, search *session-delete*, press Install.

**Command line** — one command into the profile you actually use:

```sh
dsh plugin --profile web add github:BillCx330/dsh-plugin-session-delete
```

**Release tarball** — download `dsh-plugin-session-delete-<version>.tgz` from the latest release and point `dsh plugin add` at the file.

**Local checkout** — for development, or to try a change before it is released:

```sh
dsh plugin --profile web add ./dsh-plugin-session-delete
```

The package declares `dsh.bundle`, so `dsh plugin add` appends it to `dsh.profile.bundles` for you — there is no hand-editing of the bundle list. It also ships prebuilt `lib/` output and declares no lifecycle scripts, so none of these routes runs a build script and no `allowBuilds` authorization is needed.

## Test

```powershell
node test/manifest.test.mjs
node test/host.test.mjs
node test/client.test.mjs
# or
pnpm test
```

The tests build fake session storage in a temporary directory and **never** touch real sessions under `~/.dsh`. They cover the manifest contract, real-`fs` deletion, the scan fallback, every refusal path, the removal guard, and that a removal is announced only after it succeeded while a refused one changes nothing at all.

## Model Experience

None. This plugin is a browser-side menu row plus one Host route that removes storage; it contributes no tool, no prompt section, and no model-facing surface.

#### What the model sees

Nothing. No tool is registered and no prompt is assembled or changed.

#### Token effect

None. The plugin never sends a provider request on its own.

#### KV Cache effect

None. It appends nothing to any session history — deleting a session removes a log rather than rewriting one.

## Known Limitations and Deferred Work

These are current plugin constraints, not a backlog.

- **An open (attached) session is refused**; archive it or navigate away first. The append-only writer still holds the artifact (on Windows an open file cannot be removed at all) and the loop would keep committing events into a directory that no longer exists.
- **Sub-sessions and forks are not deleted recursively** — only the selected session's own artifact goes, leaving its `parentSession` lineage and its children untouched.
- **Attachments survive**, being content-addressed and potentially shared with other sessions.
- **Deletion cannot be undone**; the confirmation dialog is what carries that responsibility.
