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

/** Read-only route the confirmation dialog uses to describe what a delete will remove. */
export declare const SESSION_DELETE_PREVIEW_PATH: '/api/session.delete.preview'

/**
 * Failure codes the Client half localizes.
 *
 * Must stay identical (order included) to the runtime array, to the Client's
 * locale dictionaries, and to its `KNOWN_FAILURE_CODES`; `test/vocabulary.test.mjs`
 * fails when any of them drifts. `'network'` is deliberately absent: the Client
 * synthesizes it when the Host could not be reached, so it has no Host code.
 *
 * There is deliberately no "live" code: a Session the Host still holds is
 * reported through `liveInMemory`/`liveSource` on a successful response, because
 * refusing it refuses every Session a deployment can see.
 */
export declare const SESSION_DELETE_CODES: readonly [
  'bad-request',
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
