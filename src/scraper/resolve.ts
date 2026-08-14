import Bluebird from 'bluebird';
import { LetterboxdMovie, LETTERBOXD_BASE_URL } from '.';
import { getMovie } from './movie';
import { SCRAPE_CONCURRENCY, ScrapeHttpOptions } from './http';
import logger from '../util/logger';

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
  http: ScrapeHttpOptions = {}
): Promise<LetterboxdMovie[]> {
  const results = await Bluebird.map(
    links,
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

  const movies = results.filter((m): m is LetterboxdMovie => m !== null);
  const skipped = links.length - movies.length;
  if (skipped > 0) {
    logger.warn(`Scraped ${movies.length}/${links.length} films; ${skipped} skipped after retries.`);
  }
  return movies;
}
