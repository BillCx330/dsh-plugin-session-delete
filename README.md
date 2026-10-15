# dsh-plugin-session-delete

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

1. **Read the stored header** — `sessionPersistence.stat(sessionId)`. With nothing stored the Session is *already gone*: the request still succeeds and finishes the bookkeeping (see *An already-gone Session is still removable*).
2. **Refuse a Session this Host still holds live** — `sessions.get(id)` / `agents.get(id)` → `live`. A live Session is one this process entered: the conversation open right now, plus every conversation resumed since startup. Nothing evicts one while the process lives (a Session's detach disposer runs when the fiber that created it is disposed, and the `agents` service exposes no dispose verb), so the delete cannot stick: `ApiSessionList.list()` unions live Sessions with persisted ones, which brings the row straight back on the next refresh, and the surviving Session's writes then fail with ENOENT because its directory is gone. Restart Harness and delete it then — see *A live Session is refused*.

   Being merely *attached in the browser* is deliberately not a refusal. The client keeps a `Session` wrapper for every row it renders so the status dot has a source, which is a client-side fact: refusing on it would refuse the whole sidebar. `sessions.get`/`agents.get` are the Host's own live store, so they refuse only what was really entered.
3. **Refuse a Session that still has running work** — anything reported by the shipped `workspace/session-activity` probe (the turn in progress, running subagents, background jobs, scheduled reminders) → `running`. That is the same read-only probe the archive flow asks before it refuses, so deleting a Session cannot orphan a job or leave a schedule firing at a Session that is gone.

   A probe that **fails** fails the request rather than being read as "idle" (`archiveSession` does not swallow this waterfall either). Deletion is irreversible, so a probe that cannot answer must not be permission; the cost of failing closed is a retryable `failed`, the cost of failing open is deleting a Session that was mid-write.

   If the probe reports work, stop it first.
4. **Remove the durable artifact** — the persistence backend names its own path (`locate(header)`); the whole session directory (every `session.vN.jsonl.zst` generation) is removed. Without `locate`, the fallback scans two levels under the configured root for a directory whose name is exactly the session id.
   **The artifact goes first, and nothing else is touched until it is confirmed gone**, so every later step only finishes a deletion that already happened and a failure can never leave a half-removed session.
5. **Then, best-effort cleanup** — a deletion that has already happened is never turned into an error by cleanup, because failing the request is what leaves the client holding a phantom row for a Session that is gone. Any problem is reported in the response as `cleanupWarnings`:
   - **Release the workspace account slot** — `unpinSession`, `unarchiveSession`, then `detachSession` on every `Workspace` **unconditionally**, removing the session from `workspace.json` for real. (`Workspace.sessionIds` is a *filtered* getter over an in-memory index the plugin does not control, so it decides what the response reports, never whether the release runs; `detachSession` is idempotent.)
   - **Remove the subagent descendants** — see *Subagents go with their parent* below.
   - **Drop the projection-cache row** — through the domain that owns it, so the in-memory table and the durable file stay coherent, rather than deleting the medium directly: `storageDomain.get('session_projcache').table('sessions').delete(id)`. `cacheRowDropped` reports the table's real answer, so an absent row is not mistaken for a dropped one.
   - **Announce the removal** — `ctx.emit('api-session/removed', sessionId)`, always, whatever the others did.

### Subagents go with their parent

Subagent Sessions are the one kind of child that is *not* safe to leave behind. A fork is a `structuredClone`d copy that becomes an ordinary independent Session; a subagent Session instead keeps a `parentSession` that is used as an **authorization witness** — access needs a two-part address, and a parent that no longer exists makes the child permanently unreachable (`subagent/unauthorized`). Hidden from the sidebar by `origin: 'subagent'`, such an orphan is invisible, unopenable, and unremovable through any surface.

They are also stored as **siblings**, not nested (`sessionDir` is `<root>/<project>/<id>/` and looks at neither `origin` nor `parentSession`), so deleting a parent directory never reaches them.

So deletion collects them through `sessionQuery.traceSession(id)` and removes the whole tree. DSH's own export treats the same tree as one Session (`includeDescendants`, packed as `subagents/<id>/…`), which makes this the shipped meaning of "delete this session".

Each child is removed through **its own stored header** — the one the trace handed over, with `cwd` intact. That matters: the JSONL backend names each artifact from `header.cwd` (`logPath(root, meta.cwd, meta.id)`), so a synthetic `{ id }` resolves to the backend's `_no-cwd` project, points the removal at a directory that does not exist, and leaves the real child on disk while the response claims it was removed. Each child also re-checks its own idleness immediately before its removal, because the trace was taken before the parent's artifact was removed.

**Fork branches are deliberately left alone** — they are independent copies and survive the parent intact, promoted to top-level rows in the sidebar. The confirmation dialog states both facts before anything is destroyed: how many subagents go with the Session, and that branched conversations stay.

Each subagent removal is best-effort and individually reported; one that fails stops neither the parent deletion nor the remaining children, and the report says *why* (a child that woke up is refused as `live`/`running`). Failures are shown in the dialog rather than only logged, so a cascade that did not fully happen is never presented as one that did.

### A live Session is refused

The Host removes the Session's *artifact*, but it cannot remove the Session the
running process still holds in memory — DSH exposes no dispose verb for that
(`agents` has `create`/`resume`/`get`/`list`; a Session's detach disposer belongs
to the fiber that entered it). So the delete cannot stick:

- the artifact directory is removed and the row disappears — it looks like a
  success;
- the live Session object is still in the store, and `ApiSessionList.list()`
  unions live Sessions with persisted ones, so **the row comes back** on the next
  list refresh or reconnect;
- the Session's log can no longer be appended to (the JSONL append opens
  `session.vN.jsonl.zst` for append, and its parent directory is gone), so the
  Session is left as a zombie that can be opened but not written to;
- the projection-cache row the plugin just deleted is rebuilt by the next
  `session/event` flush.

Refusing is therefore the honest answer, and it is the one the archive path's
own probe cannot give (archiving writes a durable flag, which *is* reversible, so
it only refuses running work). A refusal is `409` with `code: 'live'`; the copy
tells the user to restart Harness and delete it then. The artifact, the workspace
accounting and the projection cache are all untouched.

An **idle** Session that has merely been opened in this process is refused too —
being open is enough to make the row return. Sessions never entered by this
process (every other row in the sidebar) delete normally.

### An already-gone Session is still removable

A sidebar row can outlive its Session's storage. The workspace registry indexes
persisted headers at startup and live ones only through `attachSession`, so a
Session that is live but unpersisted is listed yet accounted by no Workspace —
it lands in **Ungrouped**, and `persistence.stat` has nothing to find for it.

Before this was fixed, deleting such a row failed forever (version 1.0.0 answered
`not-found`, a code this build no longer publishes): the one action offered to
remove it could never succeed, so the row was a dead end.

Deletion is now **idempotent**. When there is nothing stored, the request
returns success and runs the same cleanup — release the workspace account slot,
drop the projection-cache row, announce the removal — which is exactly what
dismisses the row. The response reports `alreadyGone: true`, plus
`liveInMemory` to say whether the Session is still held by the live store.

`liveInMemory: true` is worth paying attention to: `listSessions` unions live
sessions with persisted ones, so a Session still held in memory can reappear
after a reconnect even though its row was dropped. Restarting DSH clears such a
holder. `liveInMemory: false` means the row was simply stale and is gone for
good.

This path stays a success even when the Session is live — the request reached a
Session whose storage is already gone, so refusing would leave a row that no
operation can dismiss. Instead the dialog reports `liveInMemory` after the
delete, so the row's return on the next refresh is announced rather than
discovered.

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
- liveness and activity are re-checked immediately before the irreversible step — for the Session itself and for every subagent child.

That re-check narrows the window rather than closing it, and the code says so instead of pretending otherwise: opening a Session in the browser can promote and resume it asynchronously (the history controller's `follow` → `promote` → `agents.resume`), so a Session that passed both checks can still be entered while `rm` runs. The artifact is gone by then, so the request cannot be "un-succeeded"; instead the success payload reports `liveInMemory: true` and the dialog says so, turning a silent resurrection into an announced one. A refused removal names its real obstacle in the message (`live`, `running`, `guard`, `missing`, …).

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
    ├── manifest.test.mjs   # package-contract rules the Host and Loader apply
    ├── vocabulary.test.mjs # failure codes + locale keys agree across all five surfaces
    ├── host.test.mjs       # real-fs deletion, every refusal path, the path guard
    └── client.test.mjs     # registration shape, slot declarations, danger prop, host call
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
node test/vocabulary.test.mjs
node test/host.test.mjs
node test/client.test.mjs
# or
pnpm test
```

The tests build fake session storage in a temporary directory and **never** touch real sessions under `~/.dsh`. They cover the manifest contract, the code/locale vocabulary across all five surfaces, real-`fs` deletion, the scan fallback, every refusal path, the removal guard, and that a removal is announced only after it succeeded while a refused one changes nothing at all.

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

- **A Session with running work is refused** (turn, subagents, jobs, schedules); stop it first.
- **A Session the Host still holds live is refused** until Harness restarts — deleting it cannot stick, because the row returns and its log can no longer be written. Merely having the sidebar render a row is not "live".
- **Subagent descendants are deleted with their parent**; fork branches are not — they are independent copies and stay. Both are stated in the confirmation dialog.
- **A partial result is never presented as a clean one**: if a subagent cannot be removed, or a cleanup step fails, the dialog stays open and says which.
- **A symlink or junction at the artifact path is refused**, not followed and not unlinked.
- **Post-deletion cleanup is best-effort**; a failure is reported in `cleanupWarnings` and the deletion still stands.
- **A failing activity probe fails the request** (fail-closed) rather than being read as "idle"; retrying is safe.
- **Attachments survive**, being content-addressed and potentially shared with other sessions.
- **Deletion cannot be undone**; the confirmation dialog is what carries that responsibility.
