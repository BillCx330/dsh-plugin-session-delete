/**
 * Client half of `dsh-plugin-session-delete`.
 *
 * A Module Loader package: this file is the package's `./client` export, served
 * to the page as a `window.__ModuleLoader__.load({ id, factory })` registration.
 * The factory receives the loader's `require`, so React and the shared UI
 * primitives are resolved from the module table (the primitives are an implicit
 * baseline external) instead of being bundled a second time.
 *
 * What it contributes:
 *
 *   - one row in `sidebar.workspaces.session.menu.item`, ordered 500 — after
 *     the shipped pin (100), rename (200), fork (300), and archive (400), i.e.
 *     at the bottom of the Session "..." menu, opening its own group with the
 *     same hairline the shipped rows use
 *   - the red text and red trash glyph come from `MenuItemButton`'s own
 *     `danger` prop when the shipped primitives are present, so the row uses
 *     DSH's destructive colors rather than a look-alike; nothing about the
 *     geometry, hover fill, focus ring, or keyboard walk is reimplemented here.
 *     A build that drops or renames a primitive falls back to a local component
 *     with the same contract (see `FallbackMenuItemButton`), so the row keeps
 *     working instead of blanking the slot.
 *   - one `shell.overlay` confirmation, because the menu row unmounts with its
 *     menu and deletion is irreversible
 *
 * The confirmation posts to the Host half's `/api/session.delete` route. The
 * menu row itself never performs the deletion.
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-session-delete',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		// Optional, and deliberately guarded. The official plugin guide advises
		// against requiring Harness Client packages because their exports can
		// change without notice; the shipped look comes from these components, so
		// they are used when present, and local equivalents take over when one is
		// missing. Without this, a renamed export fails the factory and blanks the
		// whole slot entry (console: `slot entry crashed in '<slot>'`).
		let primitives = {};
		try {
			primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? {};
		} catch {
			primitives = {};
		}

		//#region route + styles
		/** Host routes registered by this package's Host half. */
		const DELETE_ROUTE = '/api/session.delete';
		const PREVIEW_ROUTE = '/api/session.delete.preview';

		/** Red text for the destructive confirm action, on the shared modal button. */
		const STYLE_TAG_ID = 'dsh-plugin-session-delete/DeleteSession.module.css';
		const CSS = [
			'.dsh-session-delete-action:not(:disabled){color:var(--dsw-alias-state-error-primary)}',
			'.dsh-session-delete-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
			'.dsh-session-delete-warn{color:var(--dsw-alias-state-warn-primary);margin-top:8px;font-size:12px;line-height:18px}',
			'.dsh-session-delete-error{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}',
			/* Fallback primitives: only rendered when the shipped components are
			   absent. Tokens only, so light/dark follow the host theme. */
			'.dsh-session-delete-item-wrap{display:flex;flex-direction:column}',
			'.dsh-session-delete-separator{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l2)}',
			'.dsh-session-delete-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
			'.dsh-session-delete-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.dsh-session-delete-item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
			'.dsh-session-delete-item-danger{color:var(--dsw-alias-state-error-primary)}',
			'.dsh-session-delete-item-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
			'.dsh-session-delete-item-icon{display:inline-flex;flex:none}',
			'.dsh-session-delete-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}',
			'.dsh-session-delete-mask{position:absolute;inset:0;background:rgba(0,0,0,.45)}',
			'.dsh-session-delete-dialog{position:relative;width:min(440px,100%);max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:20px;border-radius:12px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.2))}',
			'.dsh-session-delete-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
			'.dsh-session-delete-dialog-title{margin:0;font-size:16px;line-height:24px;font-weight:600}',
			'.dsh-session-delete-dialog-close{padding:0 2px;border:0;background:transparent;color:var(--dsw-alias-label-dimmed);font-size:18px;line-height:1;cursor:pointer}',
			'.dsh-session-delete-dialog-desc{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
			'.dsh-session-delete-dialog-body{margin-top:8px}',
			'.dsh-session-delete-dialog-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}',
			'.dsh-session-delete-button{padding:6px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
			'.dsh-session-delete-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.dsh-session-delete-button:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
		].join('');
		/** Stylesheet class names, kept as one projection the components read. */
		const css = {
			action: 'dsh-session-delete-action',
			status: 'dsh-session-delete-status',
			warn: 'dsh-session-delete-warn',
			error: 'dsh-session-delete-error',
			itemWrap: 'dsh-session-delete-item-wrap',
			separator: 'dsh-session-delete-separator',
			item: 'dsh-session-delete-item',
			itemDanger: 'dsh-session-delete-item-danger',
			itemIcon: 'dsh-session-delete-item-icon',
			overlay: 'dsh-session-delete-overlay',
			mask: 'dsh-session-delete-mask',
			dialog: 'dsh-session-delete-dialog',
			dialogHead: 'dsh-session-delete-dialog-head',
			dialogTitle: 'dsh-session-delete-dialog-title',
			dialogClose: 'dsh-session-delete-dialog-close',
			dialogDesc: 'dsh-session-delete-dialog-desc',
			dialogBody: 'dsh-session-delete-dialog-body',
			dialogFooter: 'dsh-session-delete-dialog-footer',
			button: 'dsh-session-delete-button',
		};

		//#region fallback primitives
		/**
		 * Local stand-ins for the Harness UI primitives.
		 *
		 * They exist only for a build that drops or renames an export. They keep
		 * the contract the plugin relies on (one `menuitem` button per row, a
		 * `dialog` overlay with Escape/backdrop close, a plain action button) and
		 * use theme tokens, so the row still works and still follows light/dark —
		 * it just looks less exactly like the host. No hooks: this path must also
		 * work under the offline test stub.
		 */
		function FallbackMenuItemButton({ children, icon, danger = false, separatorBefore = false, disabled = false, onSelect }) {
			return React.createElement(
				'div',
				{ className: css.itemWrap },
				separatorBefore ? React.createElement('div', { className: css.separator, role: 'separator' }) : null,
				React.createElement(
					'button',
					{
						type: 'button',
						role: 'menuitem',
						disabled,
						className: [css.item, danger ? css.itemDanger : null].filter(Boolean).join(' '),
						onClick: onSelect,
					},
					icon !== undefined ? React.createElement('span', { className: css.itemIcon }, icon) : null,
					React.createElement('span', null, children),
				),
			);
		}

		function FallbackIconTrash() {
			return React.createElement(
				'svg',
				{ width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', {
					d: 'M3.2 4.4h9.6M6.4 4.4V3.2c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.2M4.4 4.4l.6 8.2c0 .5.4.8.8.8h4.4c.4 0 .8-.3.8-.8l.6-8.2',
					stroke: 'currentColor',
					strokeWidth: 1.3,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
			);
		}

		function FallbackButton({ children, onClick, disabled = false, className }) {
			return React.createElement(
				'button',
				{
					type: 'button',
					className: [css.button, className].filter(Boolean).join(' '),
					disabled,
					onClick,
				},
				children,
			);
		}

		function FallbackModal({ open, onClose, title, closeLabel, description, children, footer }) {
			if (open !== true) return null;
			return React.createElement(
				'div',
				{ className: css.overlay, role: 'presentation' },
				React.createElement('div', { className: css.mask, 'aria-hidden': 'true', onClick: onClose }),
				React.createElement(
					'div',
					{
						className: css.dialog,
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': title,
						tabIndex: -1,
						onKeyDown: (event) => {
							if (event.key !== 'Escape') return;
							event.stopPropagation();
							onClose();
						},
					},
					React.createElement(
						'div',
						{ className: css.dialogHead },
						React.createElement('h2', { className: css.dialogTitle }, title),
						React.createElement(
							'button',
							{ type: 'button', className: css.dialogClose, 'aria-label': closeLabel, onClick: onClose },
							'×',
						),
					),
					description ? React.createElement('p', { className: css.dialogDesc }, description) : null,
					React.createElement('div', { className: css.dialogBody }, children),
					footer ? React.createElement('div', { className: css.dialogFooter }, footer) : null,
				),
			);
		}

		/**
		 * Shipped component when the build still exports it, local stand-in when it
		 * does not. Presence is the test, not `typeof === 'function'`: the module
		 * table may expose a component as a value React accepts, and a renamed
		 * export is what this guards against.
		 */
		const MenuItemButton = primitives.MenuItemButton ?? FallbackMenuItemButton;
		const Modal = primitives.Modal ?? FallbackModal;
		const Button = primitives.Button ?? FallbackButton;
		const TrashIcon = primitives.IconTrashOutlineRegular ?? FallbackIconTrash;
		//#endregion

		/**
		 * Install this package's stylesheet once. The tag is keyed so a reloaded
		 * bundle in the same page reuses it instead of stacking duplicates, and
		 * the owner count keeps several Client trees (which share this module)
		 * from removing a tag another tree still renders against.
		 */
		let styleOwners = 0;
		function insertStyles() {
			if (typeof document === 'undefined') return;
			styleOwners += 1;
			if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') !== null) return;
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-plugin-session-delete';
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * Release this owner's stylesheet. The module system strips owned styles
		 * on the code-replacement path only, not when a plugin is disabled, so the
		 * tag is released here as well; the last owner removes it.
		 */
		function removeStyles() {
			if (typeof document === 'undefined') return;
			if (styleOwners > 0) styleOwners -= 1;
			if (styleOwners > 0) return;
			const tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']');
			if (tag !== null) tag.remove();
		}
		//#endregion

		//#region observable
		/**
		 * Minimal `useSyncExternalStore` source. The Client Store package would
		 * serve here too, but one nullable value does not justify a dependency.
		 *
		 * @param initial - the initial snapshot.
		 * @returns a get/subscribe/set observable.
		 */
		function createObservable(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set: (next) => {
					if (Object.is(next, value)) return;
					value = next;
					for (const listener of [...listeners]) listener();
				},
			};
		}
		//#endregion

		//#region locales
		/** Locale namespace owned by this package's Session-deletion copy. */
		const NS = 'session-delete';

		const zh = {
			'menu.deleteSession': '删除会话',
			'dialog.title': '删除会话',
			'dialog.desc': '会话「{title}」的日志将从磁盘上永久删除，此操作无法撤销。',
			'dialog.subagents': '同时会删除它的 {n} 个子代理会话（它们不会出现在侧栏，删除父会话后将无法再打开或清理）。',
			'dialog.reminders': '同时会删除它的 {n} 条定时提醒。',
			'dialog.forks': '从中分支出的对话是独立副本，会作为独立会话保留。',
			'dialog.previewUnavailable': '无法确认该会话会连带删除多少子代理会话或定时提醒。',
			'dialog.deleted': '会话「{title}」的日志已从磁盘删除。',
			'dialog.warnTitle': '删除已完成，但有以下情况需要留意：',
			'dialog.warn.subagents': '部分子代理会话未能删除（{detail}）。它们可能已无法再打开或清理。',
			'dialog.warn.cleanup': '部分收尾步骤失败（{detail}），可能残留工作区或缓存记录。',
			'dialog.pending': '正在删除…',
			'dialog.confirm': '永久删除',
			'dialog.cancel': '取消',
			'dialog.close': '关闭',
			'dialog.untitled': '未命名',
			'error.bad-request': '删除请求无效。',
			'error.running': '该会话仍有未完成的活动（进行中的回复、子代理或后台任务）。请先停止它，然后再删除。',
			'error.unavailable': '当前部署没有挂载会话存储服务，无法删除。',
			'error.network': '无法连接到 Harness 主机。',
			'error.timeout': '删除请求超时。会话可能已经被删除，请刷新确认后再重试。',
			'error.failed': '删除失败，会话可能仍然存在。',
		};

		const en = {
			'menu.deleteSession': 'Delete session',
			'dialog.title': 'Delete session',
			'dialog.desc': 'The session log for "{title}" will be permanently removed from disk. This cannot be undone.',
			'dialog.subagents': 'Its {n} subagent session(s) will also be removed. They never appear in the sidebar and cannot be opened or cleaned up once the parent is gone.',
			'dialog.reminders': 'Its {n} scheduled reminder(s) will also be deleted.',
			'dialog.forks': 'Conversations branched from this one are independent copies and stay as their own sessions.',
			'dialog.previewUnavailable': 'Could not determine how many subagent sessions or scheduled reminders this session would also remove.',
			'dialog.deleted': 'The session log for "{title}" has been removed from disk.',
			'dialog.warnTitle': 'The deletion completed, but these points need your attention:',
			'dialog.warn.subagents': 'Some subagent sessions were not removed ({detail}). They may no longer be openable or cleanable.',
			'dialog.warn.cleanup': 'Some cleanup steps failed ({detail}); a workspace or cache entry may be left behind.',
			'dialog.pending': 'Deleting…',
			'dialog.confirm': 'Delete permanently',
			'dialog.cancel': 'Cancel',
			'dialog.close': 'Close',
			'dialog.untitled': 'Untitled',
			'error.bad-request': 'The delete request was not valid.',
			'error.running': 'This session still has running work (a turn in progress, subagents or background jobs). Stop it before deleting.',
			'error.unavailable': 'This deployment mounts no session store, so deletion is unavailable.',
			'error.network': 'Could not reach the Harness host.',
			'error.timeout': 'The delete request timed out. The session may already be deleted; refresh to check before retrying.',
			'error.failed': 'Deletion failed; the session may still be there.',
		};

		/**
		 * Failure codes this build localizes, derived from the dictionaries so the
		 * copy list stays the single source of truth.
		 */
		const KNOWN_FAILURE_CODES = new Set(
			[...Object.keys(zh), ...Object.keys(en)]
				.filter((key) => key.startsWith('error.'))
				.map((key) => key.slice('error.'.length)),
		);

		/**
		 * Localize one failure code, falling back when the Host names a code this
		 * build does not know.
		 *
		 * The Host may gain codes after this bundle was served, and a raw
		 * `error.whatever` key in a dialog is worse than an honest generic
		 * sentence. Membership is decided against the dictionaries themselves
		 * rather than against whatever `t` returns for a missing key, so the
		 * fallback does not depend on any particular locale implementation.
		 *
		 * @param t - the locale seat bound to this package's namespace.
		 * @param code - the Host's failure code.
		 * @returns a sentence written for a person.
		 */
		function failureMessage(t, code) {
			const id = typeof code === 'string' && code !== '' ? code : 'failed';
			return t(KNOWN_FAILURE_CODES.has(id) ? `error.${id}` : 'error.failed');
		}
		//#endregion

		//#region host call
		/** A deletion failure carrying the Host's own failure code. */
		class SessionDeleteError extends Error {
			constructor(code) {
				super(code);
				this.name = 'SessionDeleteError';
				this.code = code;
			}
		}

		/**
		 * How long the browser waits for the Host before it stops the spinner.
		 *
		 * The request is not cancelled on the Host side — deletion is a local
		 * `rm`, and aborting the fetch must not imply the directory survived.
		 * The timeout exists because a wedged Host otherwise leaves the dialog on
		 * "Deleting…" forever with no way out, and the copy says the Session may
		 * already be gone so the user refreshes instead of retrying blindly.
		 */
		const DELETE_TIMEOUT_MS = 90_000;

		/**
		 * Ask the Host what a deletion would remove, without removing anything.
		 *
		 * Used only to describe the blast radius in the confirmation dialog. A
		 * failure is not fatal — the deletion can still be confirmed — but it is
		 * NOT reported as "nothing else goes": `null` says "unknown", `0` says
		 * "none", and the dialog renders those two facts differently. Two things
		 * are counted: hidden subagent Sessions and the armed reminders that are
		 * deleted with the Session instead of blocking it.
		 *
		 * The Host also reports `live`/`liveSource` (diagnostics only). They are
		 * deliberately ignored here: a Session the Host still holds is the normal
		 * state of a warm app, so surfacing it every time is noise, not news.
		 *
		 * @param sessionId - the Session under consideration.
		 * @returns `{ subagents, reminders }`, or `null` when the Host could not be asked.
		 */
		async function previewDelete(sessionId) {
			try {
				const response = await fetch(PREVIEW_ROUTE, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId }),
				});
				const payload = await response.json();
				if (response.ok && payload && payload.ok === true && Array.isArray(payload.subagentIds)) {
					return {
						subagents: payload.subagentIds.length,
						// An older Host does not report reminders. That is "unknown",
						// not zero, so the dialog stays quiet instead of promising a
						// clean deletion it cannot describe.
						reminders: typeof payload.scheduledTaskCount === 'number' ? payload.scheduledTaskCount : null,
					};
				}
			} catch {
				/* the dialog can proceed without a blast radius */
			}
			return null;
		}

		/**
		 * Ask the Host half to delete one Session.
		 *
		 * @param sessionId - the Session to delete.
		 * @returns the Host's success payload.
		 * @throws {SessionDeleteError} carrying the Host's failure code.
		 */
		async function callDeleteRoute(sessionId) {
			let response;
			// `AbortSignal.timeout` is available in every Electron/Chromium the
			// desktop shell ships; a missing implementation simply means no
			// client-side deadline rather than a broken request.
			const deadline =
				typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
					? AbortSignal.timeout(DELETE_TIMEOUT_MS)
					: undefined;
			try {
				response = await fetch(DELETE_ROUTE, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId }),
					...(deadline === undefined ? {} : { signal: deadline }),
				});
			} catch (error) {
				throw new SessionDeleteError(error?.name === 'TimeoutError' ? 'timeout' : 'network');
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (response.ok && payload !== null && payload.ok === true) return payload;
			const code = typeof payload?.code === 'string' ? payload.code : 'failed';
			throw new SessionDeleteError(code);
		}
		//#endregion

		//#region menu row
		/**
		 * The Session "..." menu row (order 500). Destructive styling — red label
		 * and red trash glyph — comes from `MenuItemButton`'s `danger` prop; is an
		 * occupant of `sidebar.workspaces.session.menu.item`.
		 *
		 * @param props - the row identity, the menu's open state, and this
		 * package's request face.
		 * @returns the menu row.
		 */
		function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestSessionDelete, t }) {
			const [, setMenuOpen] = useMenuOpenState();
			return React.createElement(
				MenuItemButton,
				{
					danger: true,
					separatorBefore: true,
					icon: React.createElement(TrashIcon, {}),
					onSelect: () => {
						setMenuOpen(false);
						requestSessionDelete(sessionId, displayTitle);
					},
				},
				t('menu.deleteSession'),
			);
		}
		//#endregion

		//#region confirmation dialog
		/**
		 * The `shell.overlay` entry: nothing while no deletion is requested,
		 * otherwise one dialog per request, keyed by Session so a new request
		 * starts a fresh form.
		 *
		 * @param props - the pending request, its settlement, the deletion hop,
		 * and the locale seat.
		 * @returns the open dialog, or null.
		 */
		function DeleteSessionDialog({ useDeletePending, settleSessionDelete, deleteSession, preview, t }) {
			const request = useDeletePending((value) => value);
			if (request === null) return null;
			return React.createElement(DeleteSessionForm, {
				// One form per request: keyed by Session so a later request never
				// inherits this one's in-flight flags or result report.
				key: request.sessionId,
				request,
				settleSessionDelete,
				deleteSession,
				preview,
				t,
			});
		}

		/** Preview states that are not a count: still asking, and could not ask. */
		const PREVIEW_PENDING = { kind: 'pending' };
		const PREVIEW_UNAVAILABLE = { kind: 'unavailable' };

		/**
		 * One request's form: in-flight and error state die with it.
		 *
		 * After a successful deletion the form either settles the request (the
		 * ordinary case — nothing left to say) or stays open on a report. It stays
		 * open only when the Host returned something the user must know and would
		 * otherwise never see: a subagent that could not be removed, or a cleanup
		 * step that failed. Those are not errors — the deletion really happened —
		 * so they are not rendered as one, but the dialog does not close on top of
		 * them either.
		 *
		 * @param props - this request's identity and the injected actions.
		 * @returns the confirmation modal.
		 */
		function DeleteSessionForm({ request, settleSessionDelete, deleteSession, preview, t }) {
			const [deleting, setDeleting] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [blastRadius, setBlastRadius] = React.useState(PREVIEW_PENDING);
			const [result, setResult] = React.useState(null);
			React.useEffect(() => {
				let mounted = true;
				preview(request.sessionId).then((counts) => {
					if (!mounted) return;
					// `null` is "could not ask", NOT "nothing else goes": reporting a
					// failed preview as zero would tell the user there is no blast
					// radius at the one moment they are deciding to act on it.
					setBlastRadius(
						counts === null || counts === undefined
							? PREVIEW_UNAVAILABLE
							: { kind: 'ready', subagents: counts.subagents, reminders: counts.reminders },
					);
				});
				return () => {
					mounted = false;
				};
			}, [request.sessionId]);

			const close = () => {
				if (deleting) return;
				settleSessionDelete();
			};

			const confirm = () => {
				setDeleting(true);
				setError(null);
				deleteSession(request.sessionId).then(
					(outcome) => {
						setDeleting(false);
						const subagentWarnings = Array.isArray(outcome?.subagentWarnings) ? outcome.subagentWarnings : [];
						const cleanupWarnings = Array.isArray(outcome?.cleanupWarnings) ? outcome.cleanupWarnings : [];
						// The ordinary case: nothing to report, so the dialog closes at
						// once. `liveInMemory` is deliberately NOT a reason to keep it
						// open — a Session the Host still holds is the normal state on an
						// app that keeps sessions warm, so warning about it every time is
						// pure noise. It stays in the response as diagnostics.
						if (subagentWarnings.length === 0 && cleanupWarnings.length === 0) {
							settleSessionDelete();
							return;
						}
						// The Session is gone; these are the parts that are not fully
						// done. Console for a bug report, and the dialog for the person
						// who pressed the button.
						console.warn('[session-delete] deleted with warnings:', {
							subagentWarnings,
							cleanupWarnings,
							liveInMemory: outcome?.liveInMemory === true,
							liveAgent: outcome?.liveAgent === true,
							liveSource: outcome?.liveSource,
						});
						const reported = [];
						if (subagentWarnings.length > 0) {
							reported.push({ key: 'dialog.warn.subagents', params: { detail: subagentWarnings.join('; ') } });
						}
						if (cleanupWarnings.length > 0) {
							reported.push({ key: 'dialog.warn.cleanup', params: { detail: cleanupWarnings.join('; ') } });
						}
						setResult(reported);
					},
					(reason) => {
						setDeleting(false);
						const code = reason instanceof SessionDeleteError ? reason.code : 'failed';
						setError(code);
					},
				);
			};

			const title = request.displayTitle === '' ? t('dialog.untitled') : request.displayTitle;
			const done = result !== null;

			return React.createElement(Modal, {
				open: true,
				onClose: close,
				closeLabel: t('dialog.close'),
				title: t('dialog.title'),
				description: done ? t('dialog.deleted', { title }) : t('dialog.desc', { title }),
				footer: done
					? React.createElement(Button, {
							variant: 'outline',
							onClick: close,
							children: t('dialog.close'),
						})
					: React.createElement(
							React.Fragment,
							null,
							React.createElement(Button, {
								variant: 'outline',
								disabled: deleting,
								onClick: close,
								children: t('dialog.cancel'),
							}),
							React.createElement(Button, {
								variant: 'outline',
								className: css.action,
								disabled: deleting,
								onClick: confirm,
								children: t('dialog.confirm'),
							}),
						),
				children: [
					blastRadius.kind === 'ready' && blastRadius.subagents > 0
						? React.createElement('div', { className: css.status, role: 'note', key: 'subagents' }, t('dialog.subagents', { n: blastRadius.subagents }))
						: null,
					blastRadius.kind === 'ready' && blastRadius.reminders > 0
						? React.createElement('div', { className: css.status, role: 'note', key: 'reminders' }, t('dialog.reminders', { n: blastRadius.reminders }))
						: null,
					blastRadius.kind === 'unavailable'
						? React.createElement('div', { className: css.status, role: 'note', key: 'preview' }, t('dialog.previewUnavailable'))
						: null,
					React.createElement('div', { className: css.status, role: 'note', key: 'forks' }, t('dialog.forks')),
					deleting
						? React.createElement('div', { className: css.status, role: 'status', key: 'status' }, t('dialog.pending'))
						: null,
					done
						? React.createElement(
								'div',
								{ className: css.warn, role: 'alert', key: 'warn' },
								React.createElement('div', { key: 'warn-title' }, t('dialog.warnTitle')),
								...result.map((entry, index) => React.createElement('div', { key: `warn-${index}` }, t(entry.key, entry.params))),
							)
						: null,
					error !== null
						? React.createElement('div', { className: css.error, role: 'alert', key: 'error' }, failureMessage(t, error))
						: null,
				],
			});
		}
		//#endregion

		//#region plugin
		/** Required services: the slot registry and the locale registry. */
		const inject = ['slots', 'locale'];

		/**
		 * Register the destructive Session row and its confirmation dialog.
		 *
		 * `ctx.slots.inject` is used for both seats even though the declaring
		 * packages are normally present: it waits for the declaration, removes
		 * this contribution when that declaration collapses, and registers it
		 * again after restoration.
		 *
		 * @param ctx - the Client root context.
		 */
		function apply(ctx) {
			insertStyles();
			// The module system strips a plugin's owned styles when it replaces the
			// bundle, but not when the plugin is disabled or removed, so the tag is
			// released here too. `insertStyles`' key guard then makes a later
			// re-enable install one fresh tag instead of stacking a second one.
			ctx.effect(() => removeStyles, 'session-delete: styles');
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-delete: dictionaries');

			/** The one pending deletion request, shared by the row and the dialog. */
			const pending = createObservable(null);

			const sharedInjected = () => ({
				hooks: { deletePending: pending },
				requestSessionDelete: (sessionId, displayTitle) => {
					pending.set({
						sessionId,
						displayTitle: typeof displayTitle === 'string' ? displayTitle : '',
					});
				},
				settleSessionDelete: () => {
					pending.set(null);
				},
				deleteSession: (sessionId) => callDeleteRoute(sessionId),
				preview: (sessionId) => previewDelete(sessionId),
			});

			ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
				ctx.slots.register(
					{
						name: 'sidebar.workspaces.session.menu.item',
						id: 'dsh.session-delete',
						// 500 places the row after the shipped Archive (400): the bottom
						// of the menu, in its own group.
						order: 500,
						locale: NS,
						inject: sharedInjected,
					},
					DeleteSessionMenuItem,
				),
			);

			ctx.slots.inject('shell.overlay', () =>
				ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'dsh.session-delete.dialog',
						locale: NS,
						inject: sharedInjected,
					},
					DeleteSessionDialog,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.NS = NS;
		return module.exports;
	},
});
