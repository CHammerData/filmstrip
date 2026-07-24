import logger from '../util/logger';

// A browser-like User-Agent + Accept headers. Letterboxd (behind Cloudflare) is friendlier to these
// than to undici's bare default, and it costs nothing to look like a normal client.
const SCRAPER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** How many film pages to fetch at once. Lower than the old 10 to be gentler on Letterboxd and cut
 *  the connection-reset rate that was aborting whole syncs. */
export const SCRAPE_CONCURRENCY = 6;

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fetch()` with a browser User-Agent and retry-on-network-error, plus retry-on-403. A single
 * transient connection reset/timeout (undici throws "fetch failed") among many concurrent scrape
 * requests would otherwise abort an entire sync; retrying with linear backoff makes the scrape
 * resilient. 403 is also retried: confirmed (by comparing against curl on the identical URL and
 * headers) that undici's fetch alone gets 403 from Letterboxd/Cloudflare's bot-mitigation while a
 * real browser/curl gets 200 -- a TLS/HTTP client fingerprint false-positive, not a genuine
 * permission denial, and empirically often clears on an immediate retry. A multi-page scrape (e.g.
 * a large watched-films diary) only needs one page to hit this for the whole scrape to fail and
 * silently degrade to "nothing watched" -- see DESIGN.md §7. Every other status (404, etc.) still
 * surfaces immediately with the caller's own message.
 */
export async function fetchWithRetry(url: string): Promise<Response> {
  let lastErr: unknown;
  let lastResponse: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers: SCRAPER_HEADERS });
      if (response.status !== 403) return response;
      lastResponse = response;
      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * attempt;
        logger.debug(`Fetch ${url} got 403 (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${delay}ms.`);
        await sleep(delay);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * attempt;
        logger.debug(
          `Fetch ${url} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ` +
            `${e instanceof Error ? e.message : e}; retrying in ${delay}ms.`
        );
        await sleep(delay);
      }
    }
  }
  if (lastResponse) return lastResponse; // exhausted retries on 403s -- let the caller's status check surface it
  throw lastErr;
}
