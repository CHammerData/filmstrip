/**
 * True if `value` is an absolute URL using the http or https scheme.
 *
 * Guards the connection URLs (Radarr/Jellyfin) that get handed to axios/fetch: a schemeless value
 * like "radarr.magi-home.xyz" throws "Invalid URL" only when a request is finally made, which the
 * login flow historically mislabeled as bad credentials. Validating on save/use surfaces the real
 * problem up front. Note `new URL("radarr:7878")` parses with protocol "radarr:", so the explicit
 * http/https check is required — a bare "host:port" is not a valid http(s) URL.
 */
export function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}
