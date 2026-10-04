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
		/** Host route registered by this package's Host half. */
		const DELETE_ROUTE = '/api/session.delete';

		/** Red text for the destructive confirm action, on the shared modal button. */
		const STYLE_TAG_ID = 'dsh-plugin-session-delete/DeleteSession.module.css';
		const CSS = [
			'.dsh-session-delete-action:not(:disabled){color:var(--dsw-alias-state-error-primary)}',
			'.dsh-session-delete-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
			'.dsh-session-delete-error{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}',
		].join('');
		/** Stylesheet class names, kept as one projection the components read. */
		const css = {
			action: 'dsh-session-delete-action',
			status: 'dsh-session-delete-status',
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
			'dialog.pending': '正在删除…',
			'dialog.confirm': '永久删除',
			'dialog.cancel': '取消',
			'dialog.close': '关闭',
			'dialog.untitled': '未命名',
			'error.bad-request': '删除请求无效。',
			'error.not-found': '找不到该会话，它可能已被删除。',
			'error.live': '该会话当前已打开。请先切换到其他会话或将其归档，然后再删除。',
			'error.running': '该会话仍在运行。请先停止它，然后再删除。',
			'error.unavailable': '当前部署没有挂载会话存储服务，无法删除。',
			'error.network': '无法连接到 Harness 主机。',
			'error.failed': '删除失败，会话仍然存在。',
		};

		const en = {
			'menu.deleteSession': 'Delete session',
			'dialog.title': 'Delete session',
			'dialog.desc': 'The session log for "{title}" will be permanently removed from disk. This cannot be undone.',
			'dialog.pending': 'Deleting…',
			'dialog.confirm': 'Delete permanently',
			'dialog.cancel': 'Cancel',
			'dialog.close': 'Close',
			'dialog.untitled': 'Untitled',
			'error.bad-request': 'The delete request was not valid.',
			'error.not-found': 'This session no longer exists.',
			'error.live': 'This session is open. Switch away from it or archive it first, then delete it.',
			'error.running': 'This session still has running work. Stop it before deleting.',
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
		function DeleteSessionDialog({ useDeletePending, settleSessionDelete, deleteSession, t }) {
			const request = useDeletePending((value) => value);
			if (request === null) return null;
			return React.createElement(
				DeleteSessionForm,
				{ request, settleSessionDelete, deleteSession, t },
				request.sessionId,
			);
		}

		/**
		 * One request's form: in-flight and error state die with it.
		 *
		 * @param props - this request's identity and the injected actions.
		 * @returns the confirmation modal.
		 */
		function DeleteSessionForm({ request, settleSessionDelete, deleteSession, t }) {
			const [deleting, setDeleting] = React.useState(false);
			const [error, setError] = React.useState(null);

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
						// The Session is gone even if a cleanup step warned; the
						// dialog has nothing left to fix, so the warnings go to the
						// console rather than being surfaced as a failure.
						const warnings = outcome && Array.isArray(outcome.cleanupWarnings) ? outcome.cleanupWarnings : [];
						if (warnings.length > 0) {
							console.warn('[session-delete] deleted with cleanup warnings:', warnings);
						}
						settleSessionDelete();
					},
					(reason) => {
						setDeleting(false);
						const code = reason instanceof SessionDeleteError ? reason.code : 'failed';
						setError(code);
					},
				);
			};

			const title = request.displayTitle === '' ? t('dialog.untitled') : request.displayTitle;

			return React.createElement(Modal, {
				open: true,
				onClose: close,
				closeLabel: t('dialog.close'),
				title: t('dialog.title'),
				description: t('dialog.desc', { title }),
				footer: React.createElement(
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
					deleting
						? React.createElement('div', { className: css.status, role: 'status', key: 'status' }, t('dialog.pending'))
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
		return module.exports;
	},
});
