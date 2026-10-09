# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-03

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

## [1.0.0] - 2026-10-02

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

[1.1.0]: https://github.com/BillCx330/dsh-plugin-session-delete/releases/tag/v1.1.0
[1.0.0]: https://github.com/BillCx330/dsh-plugin-session-delete/releases/tag/v1.0.0
