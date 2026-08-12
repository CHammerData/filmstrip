import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import logger from '../util/logger';

const execFileAsync = promisify(execFile);

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
const BASE_DELAY_MS = 1500;
const CURL_TIMEOUT_SECONDS = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shell out to the system `curl` binary for one request. Confirmed directly (bypassing this app
 * entirely) that curl reliably gets 200 from Letterboxd/Cloudflare on URLs where Node's own HTTP
 * stack -- both `fetch` (undici) and the core `https` module -- consistently gets 403, on the
 * identical URL and headers: a TLS/HTTP client fingerprint false-positive in Cloudflare's
 * bot-mitigation, not a real permission denial, and not something retrying via Node's own stack
 * can ever get past (it's deterministic, not transient). The response body is written to a temp
 * file (curl's `-w` can only append trailing text to stdout, and the body may contain arbitrary
 * bytes) and read back, then discarded either way.
 */
async function fetchWithCurl(url: string): Promise<Response> {
  const tmpFile = path.join(os.tmpdir(), `filmstrip-curl-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  try {
    const { stdout } = await execFileAsync('curl', [
      '-s',
      '-L',
      '-o',
      tmpFile,
      '-w',
      '%{http_code}',
      '--max-time',
      String(CURL_TIMEOUT_SECONDS),
      '-H',
      `User-Agent: ${SCRAPER_HEADERS['User-Agent']}`,
      '-H',
      `Accept: ${SCRAPER_HEADERS['Accept']}`,
      '-H',
      `Accept-Language: ${SCRAPER_HEADERS['Accept-Language']}`,
      url,
    ]);
    const status = parseInt(stdout.trim(), 10);
    const body = await fs.readFile(tmpFile, 'utf-8');
    return new Response(body, { status, statusText: String(status) });
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

/**
 * `fetch()` with a browser User-Agent, retry-on-network-error, and a curl fallback on 403.
 * A single transient connection reset/timeout (undici throws "fetch failed") among many concurrent
 * scrape requests would otherwise abort an entire sync; retrying with linear backoff makes the
 * scrape resilient to that. A 403 is different: it's a deterministic block on Node's HTTP stack
 * specifically (see `fetchWithCurl`), so retrying via `fetch` again wouldn't help -- falls back to
 * curl on the same attempt instead of burning a retry on it.
 *
 * Once `fetch` has 403'd once in a call, it is NOT tried again on later attempts -- confirmed live
 * (Letterboxd's diary pages) that repeating it doesn't just waste a request, it appears to actively
 * re-trigger the block that then also catches the very curl call riding right behind it: a lone,
 * cold curl request to the same URL succeeds reliably, but fetch-then-curl repeated 3x in ~1.5s
 * failed every time in production. So a 403 from curl itself is retried curl-only, with backoff,
 * instead of pairing it with another doomed `fetch` call. Every other status (404, etc.) still
 * surfaces immediately with the caller's own message.
 */
export async function fetchWithRetry(url: string): Promise<Response> {
  let lastErr: unknown;
  let lastResponse: Response | undefined;
  let nodeFetchBlocked = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let response: Response;
      if (!nodeFetchBlocked) {
        response = await fetch(url, { headers: SCRAPER_HEADERS });
        if (response.status === 403) {
          nodeFetchBlocked = true;
          logger.debug(`Fetch ${url} got 403 (Node's HTTP stack is blocked here); falling back to curl.`);
          response = await fetchWithCurl(url);
        }
      } else {
        response = await fetchWithCurl(url);
      }
      if (response.status !== 403) return response;
      lastResponse = response; // curl got 403 too -- fall through to the retry/backoff below
    } catch (e) {
      lastErr = e;
    }
    if (attempt < MAX_ATTEMPTS) {
      const delay = BASE_DELAY_MS * attempt;
      logger.debug(
        `Fetch ${url} still failing (attempt ${attempt}/${MAX_ATTEMPTS}): ` +
          `${lastResponse ? `status ${lastResponse.status}` : lastErr instanceof Error ? lastErr.message : lastErr}; ` +
          `retrying in ${delay}ms.`
      );
      await sleep(delay);
    }
  }
  if (lastResponse) return lastResponse;
  throw lastErr;
}
