/**
 * Host-half type surface of `dsh-plugin-session-delete`.
 * @module dsh-plugin-session-delete
 */

/** Diagnostic name of this Host plugin. */
export declare const name: 'session-delete'

/** Required Host services. */
export declare const inject: readonly ['connection']

/** Absolute registration path of the browser-callable deletion route. */
export declare const SESSION_DELETE_PATH: '/api/session.delete'

/** Failure codes the Client half localizes. */
export declare const SESSION_DELETE_CODES: readonly [
  'bad-request',
  'not-found',
  'live',
  'running',
  'unavailable',
  'failed',
]

/**
 * Register the deletion route on the composition's authenticated fetch carrier.
 *
 * @param ctx - the Host context carrying `connection`.
 */
export declare function apply(ctx: unknown): void
