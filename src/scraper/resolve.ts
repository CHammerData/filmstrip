import Bluebird from 'bluebird';
import { LetterboxdMovie, LETTERBOXD_BASE_URL } from '.';
import { getMovie } from './movie';
import { SCRAPE_CONCURRENCY, ScrapeHttpOptions } from './http';
import logger from '../util/logger';

/**
 * A slug -> film lookup the caller supplies, so a scrape stops re-fetching film pages for films it
 * has already resolved. Deliberately an injected interface rather than a direct DB read: the
 * scraper modules stay free of prisma (and of any global), and tests supply a plain object.
 *
 * Batched on purpose — one query for a whole page of films, not one per film.
 */
export interface FilmCache {
  /** Known films, keyed by slug. Misses are simply absent from the map. */
  getMany(slugs: string[]): Promise<Map<string, LetterboxdMovie>>;
  /** Record films resolved from a live fetch. Implementations ignore films with no tmdbId. */
  putMany(movies: LetterboxdMovie[]): Promise<void>;
}

/**
 * Everything a scrape needs from its caller: where to fall back to a browser, and what it already
 * knows. One object rather than a growing tail of positional params — `fetchWithRetry` takes only
 * the HTTP half, which a `ScrapeOptions` satisfies.
 */
export interface ScrapeOptions extends ScrapeHttpOptions {
  filmCache?: FilmCache;
}

/**
 * Is this link actually a film?
 *
 * Letterboxd's grids carry a handful of non-film nodes that match the same selectors as real films
 * (promo tiles and the like), whose link is bare "/". Resolving one requests the homepage, burns a
 * full retry+backoff cycle, and logs a 403 that has nothing to do with any block -- five per list
 * page in production, which is pure noise on top of pure waste. Only /film/<slug> paths are films.
 *
 * Absolute and relative links both resolve correctly; anything unparseable is not a film.
 */
export function isFilmLink(link: string | undefined | null): link is string {
  if (!link) return false;
  try {
    return /^\/film\/[^/]+/.test(new URL(link, LETTERBOXD_BASE_URL).pathname);
  } catch {
    return false;
  }
}

/**
 * Resolve a list of Letterboxd film links to movies, tolerating individual failures. A single
 * film page that can't be fetched (after fetchWithRetry's retries) or parsed is logged and skipped
 * rather than aborting the whole list — one flaky request among hundreds must not fail the sync.
 * Runs at SCRAPE_CONCURRENCY.
 */
export async function resolveMoviesTolerant(
  links: string[],
  http: ScrapeHttpOptions = {},
  cache?: FilmCache
): Promise<LetterboxdMovie[]> {
  const cached = cache ? await cache.getMany(links) : new Map<string, LetterboxdMovie>();
  const toFetch = links.filter((link) => !cached.has(link));
  if (cache && cached.size > 0) {
    logger.debug(`Film cache: ${cached.size}/${links.length} hit; fetching ${toFetch.length}.`);
  }

  const results = await Bluebird.map(
    toFetch,
    async (link): Promise<LetterboxdMovie | null> => {
      try {
        return await getMovie(link, http);
      } catch (e) {
        logger.warn(`Skipping film ${link}: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    },
    { concurrency: SCRAPE_CONCURRENCY }
  );

  const fetched = results.filter((m): m is LetterboxdMovie => m !== null);
  if (cache && fetched.length > 0) await cache.putMany(fetched);

  // Key on the link we asked for, not on the resolved movie's own slug: Bluebird.map preserves
  // order, so index i is the answer to toFetch[i]. Keying on the returned slug would silently drop
  // films any time a film page's slug didn't echo the requested link back verbatim.
  const fetchedByLink = new Map<string, LetterboxdMovie>();
  results.forEach((movie, i) => {
    if (movie) fetchedByLink.set(toFetch[i], movie);
  });

  // Rebuild in the caller's original link order; a cache hit must be indistinguishable from a fetch.
  const movies = links
    .map((link) => cached.get(link) ?? fetchedByLink.get(link))
    .filter((m): m is LetterboxdMovie => m !== undefined);

  const skipped = links.length - movies.length;
  if (skipped > 0) {
    logger.warn(`Scraped ${movies.length}/${links.length} films; ${skipped} skipped after retries.`);
  }
  return movies;
}
