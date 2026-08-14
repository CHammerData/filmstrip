import * as cheerio from 'cheerio';
import Bluebird from 'bluebird';
import { LETTERBOXD_BASE_URL, LetterboxdMovie } from '.';
import { fetchWithRetry, SCRAPE_CONCURRENCY } from './http';
import { getMovie } from './movie';
import { isFilmLink, FilmCache, ScrapeOptions } from './resolve';
import logger from '../util/logger';

/** One diary-logged viewing, resolved to a stable film identity. */
export interface DiaryEntry {
  tmdbId: string;
  watchedAt: Date;
}

const MONTH_INDEX: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

interface RawDiaryRow {
  link: string;
  watchedAt: Date;
}

/**
 * Scrapes a user's Letterboxd diary (`/{username}/diary/`) for dated viewings. Unlike the
 * aggregate watched-films page, every entry here carries a real date -- the only reliable signal
 * for "watched since this list started tracking it" (DESIGN.md §7). Watched-but-undiaried films
 * (Letterboxd allows a bare watched-checkbox with no diary entry) simply never appear here; that's
 * intentional, not a bug -- see `getOwnerWatchedTmdbIds`.
 */
export class DiaryScraper {
  constructor(
    private username: string,
    private opts: ScrapeOptions = {}
  ) {}

  async getEntries(): Promise<DiaryEntry[]> {
    const rows = await this.getAllDiaryRows(`${LETTERBOXD_BASE_URL}/${this.username}/diary/`);
    return resolveDiaryRowsTolerant(rows, this.opts, this.opts.filmCache);
  }

  private async getAllDiaryRows(baseUrl: string): Promise<RawDiaryRow[]> {
    let currentUrl: string | null = baseUrl;
    const rows: RawDiaryRow[] = [];

    // Letterboxd only prints the month/year on the row where it changes (every row still gets its
    // own day number) -- carried forward across rows, and across pages, until the next row that
    // has it.
    let currentMonth: number | null = null;
    let currentYear: number | null = null;

    while (currentUrl) {
      logger.debug(`Fetching diary page: ${currentUrl}`);
      const response = await fetchWithRetry(currentUrl, this.opts);
      if (!response.ok) {
        throw new Error(`Failed to fetch diary page: ${response.status}`);
      }
      const html = await response.text();
      const $ = cheerio.load(html);

      $('tr.diary-entry-row').each((_, el) => {
        const row = $(el);
        const monthText = row.find('a.month').first().text().trim().slice(0, 3);
        const yearText = row.find('a.year').first().text().trim();
        if (monthText in MONTH_INDEX) currentMonth = MONTH_INDEX[monthText];
        if (yearText) {
          const year = parseInt(yearText, 10);
          if (!isNaN(year)) currentYear = year;
        }

        const dayText = row.find('a.daydate').first().text().trim();
        const day = parseInt(dayText, 10);
        const link = row.find('[data-item-link]').first().attr('data-item-link');

        if (!isFilmLink(link) || currentMonth === null || currentYear === null || isNaN(day)) {
          logger.debug('Skipping diary row: missing date or film link.');
          return;
        }
        rows.push({ link, watchedAt: new Date(Date.UTC(currentYear, currentMonth, day)) });
      });

      currentUrl = this.getNextPageUrl($, html);
      if (currentUrl) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logger.debug(`Retrieved ${rows.length} diary rows.`);
    return rows;
  }

  private getNextPageUrl($: cheerio.CheerioAPI, _html: string): string | null {
    const nextLink = $('.paginate-nextprev .next').attr('href');
    if (nextLink) {
      return new URL(nextLink, LETTERBOXD_BASE_URL).toString();
    }
    return null;
  }
}

/**
 * Resolve each diary row's film link to a tmdbId, tolerating individual failures the same way
 * `resolveMoviesTolerant` does for lists -- but keeping each entry's own watchedAt paired with it
 * (a plain filter-then-zip would desync dates from films the moment any single entry fails).
 */
async function resolveDiaryRowsTolerant(
  rows: RawDiaryRow[],
  http: ScrapeOptions = {},
  cache?: FilmCache
): Promise<DiaryEntry[]> {
  // A rewatch logs the same film on several dates, so the same slug can appear many times here --
  // dedupe before hitting the cache or the network, then fan the result back out over every row.
  const uniqueSlugs = [...new Set(rows.map((r) => r.link))];
  const cached = cache ? await cache.getMany(uniqueSlugs) : new Map<string, LetterboxdMovie>();
  const toFetch = uniqueSlugs.filter((slug) => !cached.has(slug));
  if (cache && cached.size > 0) {
    logger.debug(`Film cache: ${cached.size}/${uniqueSlugs.length} diary films hit; fetching ${toFetch.length}.`);
  }

  const results = await Bluebird.map(
    toFetch,
    async (slug): Promise<LetterboxdMovie | null> => {
      try {
        return await getMovie(slug, http);
      } catch (e) {
        logger.warn(`Skipping diary entry ${slug}: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    },
    { concurrency: SCRAPE_CONCURRENCY }
  );

  const fetched = results.filter((m): m is LetterboxdMovie => m !== null);
  if (cache && fetched.length > 0) await cache.putMany(fetched);

  // Keyed on the slug we asked for (Bluebird.map preserves order), not the resolved movie's own.
  const bySlug = new Map(cached);
  results.forEach((movie, i) => {
    if (movie) bySlug.set(toFetch[i], movie);
  });

  // Fan the resolved films back out over every row, so a rewatch keeps one entry per logged date.
  const perRow = rows.map((row): DiaryEntry | null => {
    const movie = bySlug.get(row.link);
    if (!movie?.tmdbId) return null;
    return { tmdbId: movie.tmdbId, watchedAt: row.watchedAt };
  });

  const entries = perRow.filter((r): r is DiaryEntry => r !== null);
  const skipped = rows.length - entries.length;
  if (skipped > 0) {
    logger.warn(`Resolved ${entries.length}/${rows.length} diary entries; ${skipped} skipped after retries.`);
  }
  return entries;
}
