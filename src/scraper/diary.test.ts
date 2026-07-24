import { DiaryScraper } from './diary';
import * as movieModule from './movie';
import { fetchWithRetry } from './http';

jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('./movie');
// fetchWithRetry's own retry/curl-fallback behavior is covered by http.test.ts -- mocked wholesale
// here so a 403 in these tests can't trigger a real curl subprocess call.
jest.mock('./http', () => ({
  fetchWithRetry: jest.fn(),
  SCRAPE_CONCURRENCY: 6,
}));

// Real markup captured from https://letterboxd.com/{username}/diary/ (2026-07-22). Letterboxd only
// prints the month/year on the row where it changes -- both rows below are logged the same day, so
// only the first carries <a class="month">/<a class="year">.
function diaryRow(opts: { month?: string; year?: string; day: string; itemLink: string }): string {
  const monthCell = opts.month
    ? `<div class="monthdate"><a class="month" href="#">${opts.month}</a> <a class="year" href="#">${opts.year}</a></div>`
    : '';
  return `
    <tr class="diary-entry-row viewing-poster-container">
      <td class="col-monthdate -align-center">${monthCell}</td>
      <td class="col-daydate -align-center"><a class="daydate" href="#">${opts.day}</a></td>
      <td class="col-production js-td-production">
        <div class="react-component figure" data-item-link="${opts.itemLink}"></div>
      </td>
    </tr>
  `;
}

function diaryPage(rows: string, nextHref?: string): string {
  const pagination = nextHref
    ? `<div class="paginate-nextprev"><a class="next" href="${nextHref}">Next</a></div>`
    : '';
  return `<html><body><table><tbody>${rows}</tbody></table>${pagination}</body></html>`;
}

describe('DiaryScraper', () => {
  beforeEach(() => jest.clearAllMocks());

  it('parses a single page and resolves each entry to a tmdbId + date', async () => {
    const html = diaryPage(diaryRow({ month: 'Jul', year: '2026', day: '22', itemLink: '/film/armageddon/' }));
    (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true, text: async () => html });
    (movieModule.getMovie as jest.Mock).mockResolvedValueOnce({
      id: 1,
      name: 'Armageddon',
      slug: '/film/armageddon/',
      tmdbId: '127380',
      imdbId: null,
      publishedYear: 1998,
    });

    const entries = await new DiaryScraper('chammerdata').getEntries();

    expect(entries).toEqual([{ tmdbId: '127380', watchedAt: new Date(Date.UTC(2026, 6, 22)) }]);
  });

  it('carries the month/year forward across rows that omit it (same-day entries)', async () => {
    const html = diaryPage(
      diaryRow({ month: 'Jul', year: '2026', day: '22', itemLink: '/film/armageddon/' }) +
        diaryRow({ day: '22', itemLink: '/film/heavy-metal/' }) // no month/year cell -- inherits Jul 2026
    );
    (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true, text: async () => html });
    (movieModule.getMovie as jest.Mock)
      .mockResolvedValueOnce({ id: 1, name: 'Armageddon', slug: '/film/armageddon/', tmdbId: '127380', imdbId: null, publishedYear: 1998 })
      .mockResolvedValueOnce({ id: 2, name: 'Heavy Metal', slug: '/film/heavy-metal/', tmdbId: '44973', imdbId: null, publishedYear: 1981 });

    const entries = await new DiaryScraper('chammerdata').getEntries();

    expect(entries).toEqual([
      { tmdbId: '127380', watchedAt: new Date(Date.UTC(2026, 6, 22)) },
      { tmdbId: '44973', watchedAt: new Date(Date.UTC(2026, 6, 22)) },
    ]);
  });

  it('carries the month/year forward across pages, not just within one page', async () => {
    const page1 = diaryPage(
      diaryRow({ month: 'Jul', year: '2026', day: '22', itemLink: '/film/armageddon/' }),
      'https://letterboxd.com/chammerdata/diary/page/2/'
    );
    const page2 = diaryPage(diaryRow({ day: '20', itemLink: '/film/heavy-metal/' })); // still "Jul 2026" from page 1
    (fetchWithRetry as jest.Mock)
      .mockResolvedValueOnce({ ok: true, text: async () => page1 })
      .mockResolvedValueOnce({ ok: true, text: async () => page2 });
    (movieModule.getMovie as jest.Mock)
      .mockResolvedValueOnce({ id: 1, name: 'Armageddon', slug: '/film/armageddon/', tmdbId: '127380', imdbId: null, publishedYear: 1998 })
      .mockResolvedValueOnce({ id: 2, name: 'Heavy Metal', slug: '/film/heavy-metal/', tmdbId: '44973', imdbId: null, publishedYear: 1981 });

    const entries = await new DiaryScraper('chammerdata').getEntries();

    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(entries).toEqual([
      { tmdbId: '127380', watchedAt: new Date(Date.UTC(2026, 6, 22)) },
      { tmdbId: '44973', watchedAt: new Date(Date.UTC(2026, 6, 20)) },
    ]);
  });

  it('skips a row with no resolvable film link, without failing the rest', async () => {
    const html = diaryPage(
      `<tr class="diary-entry-row"><td class="col-monthdate"><div class="monthdate"><a class="month" href="#">Jul</a> <a class="year" href="#">2026</a></div></td><td class="col-daydate"><a class="daydate" href="#">22</a></td><td class="col-production"></td></tr>` +
        diaryRow({ day: '22', itemLink: '/film/heavy-metal/' })
    );
    (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true, text: async () => html });
    (movieModule.getMovie as jest.Mock).mockResolvedValueOnce({
      id: 2,
      name: 'Heavy Metal',
      slug: '/film/heavy-metal/',
      tmdbId: '44973',
      imdbId: null,
      publishedYear: 1981,
    });

    const entries = await new DiaryScraper('chammerdata').getEntries();

    expect(entries).toEqual([{ tmdbId: '44973', watchedAt: new Date(Date.UTC(2026, 6, 22)) }]);
    expect(movieModule.getMovie).toHaveBeenCalledTimes(1);
  });

  it('skips an entry whose film fails to resolve a tmdbId, without failing the rest', async () => {
    const html = diaryPage(
      diaryRow({ month: 'Jul', year: '2026', day: '22', itemLink: '/film/some-tv-show/' }) +
        diaryRow({ day: '22', itemLink: '/film/heavy-metal/' })
    );
    (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true, text: async () => html });
    (movieModule.getMovie as jest.Mock)
      .mockResolvedValueOnce({ id: 1, name: 'Some TV Show', slug: '/film/some-tv-show/', tmdbId: null, imdbId: null, publishedYear: null })
      .mockResolvedValueOnce({ id: 2, name: 'Heavy Metal', slug: '/film/heavy-metal/', tmdbId: '44973', imdbId: null, publishedYear: 1981 });

    const entries = await new DiaryScraper('chammerdata').getEntries();

    expect(entries).toEqual([{ tmdbId: '44973', watchedAt: new Date(Date.UTC(2026, 6, 22)) }]);
  });

  it('throws when a diary page fetch fails', async () => {
    (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: false, status: 403 });

    await expect(new DiaryScraper('chammerdata').getEntries()).rejects.toThrow('Failed to fetch diary page: 403');
  });

  it('returns an empty array for a diary with no entries', async () => {
    (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true, text: async () => diaryPage('') });

    const entries = await new DiaryScraper('chammerdata').getEntries();

    expect(entries).toEqual([]);
    expect(movieModule.getMovie).not.toHaveBeenCalled();
  });
});
