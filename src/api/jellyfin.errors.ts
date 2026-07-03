/**
 * Classified Jellyfin authentication failures. Kept in its own module (no axios import) so the auth
 * service and the login route can both use it without pulling in — or being defeated by test mocks
 * of — the axios-backed api/jellyfin module.
 *
 * The login route used to collapse every failure into "Invalid Jellyfin credentials", so a wrong
 * URL or an unreachable server looked like a bad password. Each cause now carries its own kind
 * (mapped to an honest HTTP status) and a server-only `detail` for logs.
 */
export type JellyfinAuthErrorKind =
  | 'invalid-url' // the configured URL isn't a valid absolute http(s) URL
  | 'bad-credentials' // Jellyfin rejected the username/password (HTTP 401)
  | 'unreachable' // no HTTP response at all (DNS/refused/timeout)
  | 'bad-response'; // reachable but returned an unexpected status/body

export class JellyfinAuthError extends Error {
  constructor(
    public readonly kind: JellyfinAuthErrorKind,
    /** Client-safe message (returned to the browser). Must not leak internal hostnames. */
    message: string,
    /** Server-only detail for logs (may include the URL and upstream cause). */
    public readonly detail?: string,
    /** The original underlying error, for logging. */
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'JellyfinAuthError';
  }
}

/** HTTP status the login route returns for each failure kind. */
export const jellyfinAuthErrorStatus: Record<JellyfinAuthErrorKind, number> = {
  'invalid-url': 400,
  'bad-credentials': 401,
  unreachable: 502,
  'bad-response': 502,
};
