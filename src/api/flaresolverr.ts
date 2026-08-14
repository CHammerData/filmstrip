import Axios from 'axios';
import logger from '../util/logger';

/**
 * FlareSolverr client -- the scraper's last-resort HTTP fallback.
 *
 * Letterboxd serves page 1 of any list to any client, but gates paginated paths (`.../page/2/` and
 * beyond) on the request looking like a real browser. Confirmed live against `/films/popular/page/2/`,
 * a URL with no account context at all: page 1 returns 200 to curl, page 2 returns 403 to curl
 * cold, with a valid page-1 session, and with a Referer -- while a real browser loads it fine from
 * both a home connection and a cellular one. So it isn't the IP, isn't cookies, and isn't the
 * account; it's a client check that no plain HTTP stack passes by construction.
 *
 * FlareSolverr drives an actual headless browser, which is the only thing that clears it. It is
 * correspondingly expensive (a browser navigation per request), so the scraper only calls this
 * after both `fetch` and curl have been refused -- see `fetchWithRetry`.
 */
export interface FlaresolverrConnection {
  url: string;
}

/** The `solution` payload FlareSolverr returns for a solved request (subset we use). */
interface FlaresolverrSolution {
  url: string;
  status: number;
  response: string;
}

interface FlaresolverrResponse {
  status: 'ok' | 'error';
  message?: string;
  solution?: FlaresolverrSolution;
}

/**
 * How long FlareSolverr may spend clearing one URL. Generous: it may need to sit through a
 * Cloudflare interstitial, and the alternative to waiting is a failed scrape.
 */
const MAX_TIMEOUT_MS = 60_000;

/**
 * Fetch one URL through FlareSolverr and return it as a `Response`, so callers can treat it
 * interchangeably with `fetch`/curl results.
 *
 * Throws if FlareSolverr itself is unreachable or reports an error -- a browser that couldn't run
 * is a different failure from a page that came back 403, and the caller logs them differently.
 */
export async function fetchViaFlaresolverr(conn: FlaresolverrConnection, url: string): Promise<Response> {
  const endpoint = `${conn.url.replace(/\/$/, '')}/v1`;
  let data: FlaresolverrResponse;
  try {
    const res = await Axios.post<FlaresolverrResponse>(
      endpoint,
      { cmd: 'request.get', url, maxTimeout: MAX_TIMEOUT_MS },
      // Give the HTTP call more room than the browser budget, so a FlareSolverr that is still
      // working is never cut off by our own client timeout.
      { timeout: MAX_TIMEOUT_MS + 15_000, headers: { 'Content-Type': 'application/json' } }
    );
    data = res.data;
  } catch (e) {
    const detail = Axios.isAxiosError(e) ? e.response?.data ?? e.message : e instanceof Error ? e.message : e;
    throw new Error(`FlareSolverr request to ${endpoint} failed: ${JSON.stringify(detail)}`);
  }

  if (data.status !== 'ok' || !data.solution) {
    throw new Error(`FlareSolverr could not solve ${url}: ${data.message ?? 'no solution returned'}`);
  }

  logger.debug(`FlareSolverr returned ${data.solution.status} for ${url}.`);
  return new Response(data.solution.response, {
    status: data.solution.status,
    statusText: String(data.solution.status),
  });
}
