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
 *     `danger` prop, so the row uses DSH's destructive colors rather than a
 *     look-alike; nothing about the geometry, hover fill, focus ring, or
 *     keyboard walk is reimplemented here
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
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		const {
			Button,
			IconTrashOutlineRegular,
			MenuItemButton,
			Modal,
		} = primitives;

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
		].join('');
		/** Stylesheet class names, kept as one projection the components read. */
		const css = {
			action: 'dsh-session-delete-action',
			status: 'dsh-session-delete-status',
			warn: 'dsh-session-delete-warn',
			error: 'dsh-session-delete-error',
		};

		/**
		 * Install this package's stylesheet once. The tag is keyed so a reloaded
		 * bundle in the same page reuses it instead of stacking duplicates.
		 */
		function insertStyles() {
			if (typeof document === 'undefined') return;
			if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') !== null) return;
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-plugin-session-delete';
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * Remove this package's stylesheet. The module system strips owned styles
		 * on the code-replacement path only, not when a plugin is disabled, so the
		 * tag is released here as well; without this the rules stay in the document
		 * for the rest of the page's life.
		 */
		function removeStyles() {
			if (typeof document === 'undefined') return;
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
			'dialog.forks': '从中分支出的对话是独立副本，会作为独立会话保留。',
			'dialog.previewUnavailable': '无法确认该会话有多少个子代理会话。',
			'dialog.liveWarning': '该会话正在本进程中活动：日志会被删除，但在你刷新页面或重连之前，这一行可能再次出现（重启 Harness 后会彻底消失）。',
			'dialog.deleted': '会话「{title}」的日志已从磁盘删除。',
			'dialog.warnTitle': '删除已完成，但有以下情况需要留意：',
			'dialog.warn.subagents': '部分子代理会话未能删除（{detail}）。它们已无法再打开或清理。',
			'dialog.warn.cleanup': '部分收尾步骤失败（{detail}），可能残留工作区或缓存记录。',
			'dialog.warn.live': '该会话仍被当前 Harness 进程持有，刷新页面或重连后这一行可能会回来；再删一次即可，重启 Harness 后彻底消失。',
			'dialog.pending': '正在删除…',
			'dialog.confirm': '永久删除',
			'dialog.cancel': '取消',
			'dialog.close': '关闭',
			'dialog.untitled': '未命名',
			'error.bad-request': '删除请求无效。',
			'error.running': '该会话仍有未完成的活动（进行中的回复、子代理、后台任务或定时提醒）。请先停止它，然后再删除。',
			'error.unavailable': '当前部署没有挂载会话存储服务，无法删除。',
			'error.network': '无法连接到 Harness 主机。',
			'error.failed': '删除失败，会话仍然存在。',
		};

		const en = {
			'menu.deleteSession': 'Delete session',
			'dialog.title': 'Delete session',
			'dialog.desc': 'The session log for "{title}" will be permanently removed from disk. This cannot be undone.',
			'dialog.subagents': 'Its {n} subagent session(s) will also be removed. They never appear in the sidebar and cannot be opened or cleaned up once the parent is gone.',
			'dialog.forks': 'Conversations branched from this one are independent copies and stay as their own sessions.',
			'dialog.previewUnavailable': 'Could not determine how many subagent sessions this session has.',
			'dialog.liveWarning': 'This session is live in the running process: the log will be deleted, but the row may come back until you refresh or reconnect (a Harness restart removes it for good).',
			'dialog.deleted': 'The session log for "{title}" has been removed from disk.',
			'dialog.warnTitle': 'The deletion completed, but these points need your attention:',
			'dialog.warn.subagents': 'Some subagent sessions were not removed ({detail}). They can no longer be opened or cleaned up.',
			'dialog.warn.cleanup': 'Some cleanup steps failed ({detail}); a workspace or cache entry may be left behind.',
			'dialog.warn.live': 'This session is still held by the running Harness process, so the row may come back after a refresh or reconnect; delete it again, or restart Harness to remove it for good.',
			'dialog.pending': 'Deleting…',
			'dialog.confirm': 'Delete permanently',
			'dialog.cancel': 'Cancel',
			'dialog.close': 'Close',
			'dialog.untitled': 'Untitled',
			'error.bad-request': 'The delete request was not valid.',
			'error.running': 'This session still has running work (a turn in progress, subagents, background jobs or scheduled reminders). Stop it before deleting.',
			'error.unavailable': 'This deployment mounts no session store, so deletion is unavailable.',
			'error.network': 'Could not reach the Harness host.',
			'error.failed': 'Deletion failed; the session is still there.',
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
		 * Ask the Host what a deletion would remove, without removing anything.
		 *
		 * Used only to describe the blast radius in the confirmation dialog. A
		 * failure is not fatal — the deletion can still be confirmed — but it is
		 * NOT reported as "no subagents": `ids: null` says "unknown", `[]` says
		 * "none", and the dialog renders those two facts differently.
		 *
		 * `live` says whether the Host still holds the Session. That does not
		 * block the deletion any more, so the dialog uses it to warn BEFORE the
		 * user confirms that the row can come back until Harness restarts.
		 *
		 * @param sessionId - the Session under consideration.
		 * @returns the subagent ids (`null` when the Host could not be asked) and
		 *   whether the Host holds the Session live.
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
					return { ids: payload.subagentIds, live: payload.live === true };
				}
			} catch {
				/* the dialog can proceed without a blast radius */
			}
			return { ids: null, live: false };
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
			try {
				response = await fetch(DELETE_ROUTE, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId }),
				});
			} catch {
				throw new SessionDeleteError('network');
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
					icon: React.createElement(IconTrashOutlineRegular, {}),
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
		const PREVIEW_PENDING = -1;
		const PREVIEW_UNAVAILABLE = -2;

		/**
		 * One request's form: in-flight and error state die with it.
		 *
		 * After a successful deletion the form either settles the request (the
		 * ordinary case — nothing left to say) or stays open on a report. It stays
		 * open when the Host returned something the user must know and would
		 * otherwise never see: a subagent that could not be removed, a cleanup step
		 * that failed, or a live Session whose row will come back. Those are not
		 * errors — the deletion really happened — so they are not rendered as one,
		 * but the dialog does not close on top of them either.
		 *
		 * @param props - this request's identity and the injected actions.
		 * @returns the confirmation modal.
		 */
		function DeleteSessionForm({ request, settleSessionDelete, deleteSession, preview, t }) {
			const [deleting, setDeleting] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [subagents, setSubagents] = React.useState(PREVIEW_PENDING);
			const [result, setResult] = React.useState(null);
			const [heldLive, setHeldLive] = React.useState(false);
			React.useEffect(() => {
				let mounted = true;
				preview(request.sessionId).then((previewed) => {
					if (!mounted) return;
					// `null` is "could not ask", NOT "none": reporting a failed
					// preview as zero would tell the user there is no blast radius at
					// the one moment they are deciding to act on it.
					const ids = previewed?.ids;
					setSubagents(ids === null || ids === undefined ? PREVIEW_UNAVAILABLE : ids.length);
					setHeldLive(previewed?.live === true);
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
						const liveInMemory = outcome?.liveInMemory === true;
						if (subagentWarnings.length === 0 && cleanupWarnings.length === 0 && !liveInMemory) {
							settleSessionDelete();
							return;
						}
						// The Session is gone; these are the parts that are not fully
						// done. Console for a bug report, and the dialog for the person
						// who pressed the button.
						console.warn('[session-delete] deleted with warnings:', {
							subagentWarnings,
							cleanupWarnings,
							liveInMemory,
						});
						const reported = [];
						if (subagentWarnings.length > 0) {
							reported.push({ key: 'dialog.warn.subagents', params: { detail: subagentWarnings.join('; ') } });
						}
						if (cleanupWarnings.length > 0) {
							reported.push({ key: 'dialog.warn.cleanup', params: { detail: cleanupWarnings.join('; ') } });
						}
						if (liveInMemory) reported.push({ key: 'dialog.warn.live', params: {} });
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
					subagents > 0
						? React.createElement('div', { className: css.status, role: 'note', key: 'subagents' }, t('dialog.subagents', { n: subagents }))
						: null,
					subagents === PREVIEW_UNAVAILABLE
						? React.createElement('div', { className: css.status, role: 'note', key: 'preview' }, t('dialog.previewUnavailable'))
						: null,
					React.createElement('div', { className: css.status, role: 'note', key: 'forks' }, t('dialog.forks')),
					heldLive && !done
						? React.createElement('div', { className: css.warn, role: 'note', key: 'live' }, t('dialog.liveWarning'))
						: null,
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
						id: 'session-delete',
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
						id: 'session-delete.dialog',
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
