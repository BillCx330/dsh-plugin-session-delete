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

### Changed

- **Artifact first.** The durable artifact is removed and confirmed before any
  workspace, cache, or notification step runs. A refused or failed removal now
  leaves workspace accounting, the projection cache, and the client's list
  completely untouched, instead of a session that was detached from its
  workspace but still on disk.

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
