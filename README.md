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

The Host half runs these steps in order:

1. **Read the stored header** — `sessionPersistence.stat(sessionId)`; absent → `not-found`.
2. **Refuse a Session that still has running work** — anything reported by the shipped `workspace/session-activity` probe (the turn in progress, running subagents, background jobs, scheduled reminders) → `running`. That is the same read-only probe the archive flow asks before it refuses, so deleting a Session cannot orphan a job or leave a schedule firing at a Session that is gone.

   Being merely *open* is deliberately not a refusal. The client keeps every visible Session row attached (so the status dot has a source at all), so an attached-but-idle Session is the ordinary case in the sidebar — refusing it would refuse every row. And on Windows an open file cannot be removed at all, so a writer that really is holding the artifact makes the removal fail honestly rather than corrupting anything.

   If the probe reports work, stop it first.
3. **Remove the durable artifact** — the persistence backend names its own path (`locate(header)`); the whole session directory (every `session.vN.jsonl.zst` generation) is removed. Without `locate`, the fallback scans two levels under the configured root for a directory whose name is exactly the session id.
   **The artifact goes first, and nothing else is touched until it is confirmed gone**, so every later step only finishes a deletion that already happened and a failure can never leave a half-removed session.
4. **Then, best-effort cleanup** — a deletion that has already happened is never turned into an error by cleanup, because failing the request is what leaves the client holding a phantom row for a Session that is gone. Any problem is reported in the response as `cleanupWarnings`:
   - **Release the workspace account slot** — `unpinSession`, `unarchiveSession`, then `detachSession` on every `Workspace` that accounts for it, removing the session from `workspace.json` for real.
   - **Remove the subagent descendants** — see *Subagents go with their parent* below.
   - **Drop the projection-cache row** — through the domain that owns it, so the in-memory table and the durable file stay coherent, rather than deleting the medium directly: `storageDomain.get('session_projcache').table('sessions').delete(id)`.
   - **Announce the removal** — `ctx.emit('api-session/removed', sessionId)`, always, whatever the others did.

### Subagents go with their parent

Subagent Sessions are the one kind of child that is *not* safe to leave behind. A fork is a `structuredClone`d copy that becomes an ordinary independent Session; a subagent Session instead keeps a `parentSession` that is used as an **authorization witness** — access needs a two-part address, and a parent that no longer exists makes the child permanently unreachable (`subagent/unauthorized`). Hidden from the sidebar by `origin: 'subagent'`, such an orphan is invisible, unopenable, and unremovable through any surface.

They are also stored as **siblings**, not nested (`sessionDir` is `<root>/<project>/<id>/` and looks at neither `origin` nor `parentSession`), so deleting a parent directory never reaches them.

So deletion collects them through `sessionQuery.traceSession(id)` and removes the whole tree. DSH's own export treats the same tree as one Session (`includeDescendants`, packed as `subagents/<id>/…`), which makes this the shipped meaning of "delete this session".

**Fork branches are deliberately left alone** — they are independent copies and survive the parent intact, promoted to top-level rows in the sidebar. The confirmation dialog states both facts before anything is destroyed: how many subagents go with the Session, and that branched conversations stay.

Each subagent removal is best-effort and individually reported; one that fails stops neither the parent deletion nor the remaining children.

### Why the removal must be announced

A client's sidebar list only ever **grows** from the `api-session/added` event; it is otherwise rebuilt in full on reconnect (`handleConnected` → `refreshList`). So a session deleted on the Host keeps a row in the browser — a row that cannot be opened.

Ungrouped is derived as `list.ids.filter(id => !accounted.has(id))` — sessions the list holds that no Workspace accounts for. Releasing the workspace account slot therefore moves the phantom row out of its workspace group and **into Ungrouped**, where opening it fails with `session/not-found`.

`api-session/removed` is the shipped signal for exactly this: `api-session-controller` emits it when a session is disposed, `api-remotes` forwards it (it is on that package's forwarded-event allowlist), and the client's session-controller drops the row on receipt. Announcing it makes the row disappear **immediately**, with no page reload.

> If your sidebar still holds sessions deleted by version 1.0.0 (which the Host no longer has), **one page reload** clears them: the reconnect refresh discards identities absent from the baseline (`mergeOrderedBaseline`: *identities absent from the baseline are removed*).

### Safety guard

Removal is the one irreversible step, so the target is proven before it is touched; failing any clause is **reported, never deleted**:

- the path must be absolute;
- its final segment must be exactly the requested session id;
- it must sit strictly inside the persistence root;
- it must be a real directory — a symlink or junction at that path is refused rather than unlinked, because a link is not evidence that this Session owns what is behind it (recursion never follows one either: both cases were measured, not assumed);
- liveness is re-checked immediately before the irreversible step, closing the window in which a Session became active after the first check.

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

- **A Session with running work is refused** (turn, subagents, jobs, schedules); stop it first. Being merely open is not a refusal — the sidebar keeps every row attached.
- **Subagent descendants are deleted with their parent**; fork branches are not — they are independent copies and stay. Both are stated in the confirmation dialog.
- **A symlink or junction at the artifact path is refused**, not followed and not unlinked.
- **Post-deletion cleanup is best-effort**; a failure is reported in `cleanupWarnings` and the deletion still stands.
- **Attachments survive**, being content-addressed and potentially shared with other sessions.
- **Deletion cannot be undone**; the confirmation dialog is what carries that responsibility.
