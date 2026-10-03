/**
 * Client-half type surface of `dsh-plugin-session-delete`.
 *
 * The runtime half is the plain-JavaScript Module Loader bundle at
 * `lib/client.js`; these declarations describe its contract for authors who
 * import this package for types.
 *
 * @module dsh-plugin-session-delete/client
 */

import type { Context } from '@deepseek-ai/cordis'

/** Locale namespace this package owns. */
export declare const NS: 'session-delete'

/** Required Client services. */
export declare const inject: readonly ['slots', 'locale']

/**
 * Register the destructive Session menu row (order 500) and its `shell.overlay`
 * confirmation dialog.
 *
 * @param ctx - the Client root context.
 */
export declare function apply(ctx: Context): void

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-delete':
      | 'menu.deleteSession'
      | 'dialog.title'
      | 'dialog.desc'
      | 'dialog.pending'
      | 'dialog.confirm'
      | 'dialog.cancel'
      | 'dialog.close'
      | 'dialog.untitled'
      | 'error.bad-request'
      | 'error.not-found'
      | 'error.live'
      | 'error.running'
      | 'error.unavailable'
      | 'error.network'
      | 'error.failed'
  }
}
