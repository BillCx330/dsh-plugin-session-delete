# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **A note on versions.** This repository was first published at 1.2.0. The 1.0.0
> and 1.1.0 entries below describe work done before that first push: their
> commits are part of the initial history, but they were never tagged or
> released, so `v1.2.0` is the only version with a release page.

## [1.2.0] - 2026-10-14

Fixes the deletion semantics themselves. Review against the shipped DSH source
found that subagent cascade deletion never actually worked, that a live Session
was deleted and then silently came back, and that the activity probe failed
*open* on an irreversible operation. The four cases — cold Session, live
Session, running Session, subagent — are now all correct.

### Fixed

- **Subagent cascade deletion never removed anything.** Every child was removed
  through a synthetic `{ id }` header, and the JSONL backend names each artifact
  from `header.cwd` (`logPath(root, meta.cwd, meta.id)`) — so the path resolved
  to the backend's `_no-cwd` project, `lstat` found nothing, and the real child
  stayed on disk while the response said `artifact not removed`. The `cwd`-blind
  test double hid it: its `locate()` ignored `cwd`, so a synthetic header and a
  real one produced the same path and the cascade test passed. Children are now
  removed through the header `traceSession` actually returned (which carries the
  parent's inherited `cwd`), and the test double mirrors the backend's `_no-cwd`
  layout, with a regression case for a header that names the wrong project.
- **A live Session was deleted and then came back.** `liveOrRunning` only asked
  the activity probe, so an idle Session the Host still held live was deleted:
  the artifact and the row went away, but `ApiSessionList.list()` unions live
  Sessions with persisted ones, so the row returned on the next refresh and the
  surviving Session was left as a zombie whose appends fail with ENOENT (its
  directory is gone). Nothing in DSH can evict a live Session — `agents` exposes
  no dispose verb — so this is now a `409` `live`, with the artifact, workspace
  accounting and cache untouched, and copy telling the user to restart Harness.
- **The activity probe failed open.** A listener that threw was read as "the
  Session is idle", so a transient probe failure could delete a Session that was
  mid-write. The shipped `archiveSession` does not contain this waterfall
  either; the probe now propagates and the request fails closed (retryable).
- **Subagent removals had no pre-removal re-check** while the parent did, even
  though the child window is the widest in the handler (the trace is taken
  before the parent's artifact goes). Each child now re-checks its own liveness
  and activity immediately before removal and reports *why* it stayed.
- **`cacheRowDropped` was always `true`.** `KvTableImpl.delete` resolves `false`
  when the key is absent; the result is now reported.
- **Workspace release depended on a filtered getter.** `Workspace.sessionIds`
  filters by an in-memory header index the plugin does not control, so a
  re-index between the `rm` and the release could skip a Session that really was
  accounted. `detachSession` (idempotent) is now called unconditionally; the
  getter only decides what `detachedFrom` reports.
- **A partial result was invisible.** `subagentWarnings` was dropped entirely
  (only `cleanupWarnings` reached `console.warn`) and the dialog had already
  closed, so a cascade that did not happen looked exactly like one that did. A
  successful delete that carries any warning — or a `liveInMemory` row — now
  keeps the dialog open and says what is left.
- **A failed preview rendered as "no subagents".** The dialog now distinguishes
  "could not ask" from "none".
- **The package's own stylesheet survived disabling the plugin.** The module
  system strips owned styles on the code-replacement path only; the Client half
  now releases its tag through `ctx.effect`.
- **A refused removal blamed the wrong thing.** `removeArtifact` collapsed five
  outcomes (unlocated, path-guard refusal, missing directory, not a directory, a
  failed pre-removal re-check, still present afterwards) into one boolean pair,
  so a Session that became live between the two checks was reported as "refused
  by the removal guard" and a child that had simply never flushed printed a bare
  "artifact not removed". Every outcome now carries a reason
  (`unlocated`/`guard`/`missing`/`not-a-directory`/`stayed`/`live`/`running`),
  the 500 message names it, and each child warning prints it.
- **`NS` was declared in the Client's `.d.ts` but never exported.** The bundle
  exported only `apply`/`inject`, so importing the namespace type-checked and
  yielded `undefined`; it is now a real export and `vocabulary.test.mjs` ties it
  to the declared locale map.
- **The test doubles were blind to the backend's path rule** (see the first
  item): the fake `locate` now returns `_no-cwd` for a missing `cwd`.

### Changed

- **A live Session is now refused**, including an idle one that the sidebar has
  merely opened in this process. This is not the same as client-side
  *attachment*: the browser keeps a `Session` wrapper for every rendered row,
  which is a client fact and is still not a refusal. What is refused is the
  Host's own live store (`sessions.get`/`agents.get`).
- **The pre-removal re-check is documented as narrowing the window, not closing
  it** (opening a Session can promote and resume it asynchronously), and a
  successful removal now reports `liveInMemory` afterwards so a Session that was
  entered while `rm` ran is announced by the dialog instead of surprising the
  user on the next refresh.
- **`SESSION_DELETE_CODES` gains `live` and drops the unreachable
  `not-found`** (the already-gone path deliberately answers `200`). The Host
  array, both dictionaries, the Client's derived `KNOWN_FAILURE_CODES`, and both
  `.d.ts` files are now kept in lockstep by `test/vocabulary.test.mjs`.
- **Documented the live-refusal and fail-closed behaviour** in both READMEs.

### Testing

- `test/vocabulary.test.mjs` is new: it fails when any of the five vocabulary
  surfaces (runtime Host codes, runtime Client dictionaries, Host `.d.ts`,
  Client `.d.ts`) drifts from the others, and when the registered locale
  namespace differs from the declared one.
- The subagent fixtures carry real `cwd`-bearing headers, so a regression to a
  synthetic header fails the cascade test instead of passing it.
- Coverage added for the paths a revert could otherwise slip through: the real
  preview hop (URL included, so the destructive route cannot be pasted into it),
  a Session held only by the agent registry, a re-check that throws for the
  parent and for a child, and the id handed to `traceSession`.

## 1.1.0 - 2026-10-03

Deleting a session no longer leaves a phantom row behind, and the deletion is
now atomic: nothing else changes unless the artifact is really gone.

### Added

- **Client rows disappear immediately.** After a confirmed deletion the Host
  emits `api-session/removed`, the shipped signal for a session going away, so
  the client's session list drops the row without a page reload. Without it the
  list — which only ever grows from `api-session/added` and is otherwise
  rebuilt on reconnect — kept a row that could no longer be opened, and since
  the session was no longer accounted by any workspace it surfaced under
  *Ungrouped*, failing with `session/not-found`.
- **Projection-cache cleanup.** The deleted session's `session_projcache` row
  is removed through the storage domain that owns it, so the in-memory table
  and the durable file stay coherent.
- **Subagent descendants are deleted with their parent.** Subagent Sessions are
  the one child kind that is not safe to leave behind: unlike a fork (a
  `structuredClone`d copy that becomes an independent Session), a subagent
  Session keeps a `parentSession` used as an authorization witness, so a parent
  that is gone makes the child permanently unreachable (`subagent/unauthorized`)
  — and being hidden by `origin: 'subagent'`, such an orphan is invisible,
  unopenable and unremovable through any surface. They are also stored as
  siblings (`sessionDir` looks at neither `origin` nor `parentSession`), so
  deleting a parent directory never reaches them. Deletion now collects the
  whole tree through `sessionQuery.traceSession(id)` and removes it — the same
  tree DSH's own export treats as one Session (`includeDescendants`). Each
  child removal is best-effort and individually reported.
- **A read-only preview route** (`/api/session.delete.preview`) describes the
  blast radius before anything is destroyed. The confirmation dialog shows the
  subagent count alongside a note that branched conversations survive as
  independent sessions.

### Changed

- **Artifact first.** The durable artifact is removed and confirmed before any
  workspace, cache, or notification step runs. A refused or failed removal now
  leaves workspace accounting, the projection cache, and the client's list
  completely untouched, instead of a session that was detached from its
  workspace but still on disk.
- **Active work blocks deletion.** The plugin asks the shipped read-only
  `workspace/session-activity` probe — the same one the archive path asks
  before it refuses — and declines a session whose turn, subagents, background
  jobs or scheduled reminders are still running. This also replaces an
  expensive full session-list read with a precise per-session one.
- **Being attached is no longer a refusal.** The client keeps every visible
  Session row attached (`useSessionStatus` retains it so the status dot has a
  source at all), so "attached but idle" is the ordinary state of every row in
  the sidebar. Refusing on that basis refused *every* session — reported as
  "this Session is open in this process" no matter which row you chose. The
  only remaining refusal is reported activity, which is what actually has to
  stop before a deletion. On Windows an open file cannot be removed at all, so
  a writer genuinely holding the artifact still fails the removal honestly
  instead of corrupting anything.
- **Cleanup after deletion is best-effort.** A cleanup failure is reported in
  `cleanupWarnings` and never turns a real deletion into an error response,
  because an error response is exactly what leaves the client holding a
  phantom row.
- **A symlink or junction at the artifact path is refused** rather than
  unlinked, and `lstat` replaces `stat` so a link is never mistaken for a
  directory this session owns.

### Fixed

- **A row whose Session was already gone could never be removed.** Deleting it
  reported `not-found` forever, so the one action offered to clear it could
  never succeed — a dead end in *Ungrouped*. Such rows are real: the workspace
  registry indexes persisted headers at startup and live ones only through
  `attachSession`, so a Session that is live but unpersisted is listed yet
  accounted by no Workspace, and `persistence.stat` has nothing to find for it.
  Deletion is now idempotent — with nothing stored it still succeeds and runs
  the same cleanup (release the account slot, drop the cache row, announce the
  removal), which is what dismisses the row. The response reports
  `alreadyGone: true` and `liveInMemory`, distinguishing a merely stale row from
  one still held by the live store (which can return after a reconnect; a DSH
  restart clears it).
- **A cleanup failure left a phantom row.** Once the artifact was gone, a throw
  from the workspace release returned an error and skipped the removal
  announcement, so the client kept an unopenable row for a deleted session.
  The removal is now always announced once the artifact is gone.
- **`detachedFrom` reported `undefined`.** The workspace entity exposes `id`,
  not `workspaceId`; the response now carries the real id.
- **Unknown failure codes leaked a raw locale key** into the dialog. It now
  falls back to the generic message, decided against the dictionaries rather
  than against whatever a locale returns for a missing key.
- **`.` and `..` are rejected as session ids** at the request boundary rather
  than left for a later guard to notice.
- **Liveness is re-checked immediately before the irreversible step**, closing
  the window in which a session became active after the first check.
- **The test doubles were test-blind.** They now mirror the real workspace
  entity shape (`id`, not `workspaceId`) and report activity through the
  shipped probe, so a drift between the plugin and the runtime fails a test
  instead of passing one.

## 1.0.0 - 2026-10-02

First release.

- A **Delete session** row at the bottom of a Session's `⋯` menu
  (`sidebar.workspaces.session.menu.item`, order 500), reusing DSH's own
  `MenuItemButton` so the geometry, hover fill, focus ring and keyboard walk
  are the shipped ones; `danger` gives the label and the trash glyph DSH's own
  destructive red.
- A confirmation dialog in `shell.overlay`, since the menu row unmounts with
  its menu and deletion is irreversible.
- Host half deletes the durable session artifact and releases the workspace
  account slot, with a removal guard that proves the target is absolute, owned
  by exactly the requested session id, and strictly inside the persistence
  root before anything is removed.
- Live/attached sessions are refused rather than force-deleted.

[1.2.0]: https://github.com/BillCx330/dsh-plugin-session-delete/releases/tag/v1.2.0
