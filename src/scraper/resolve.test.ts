import { resolveMoviesTolerant, isFilmLink } from './resolve';
import { getMovie } from './movie';

jest.mock('../util/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('./movie');

const mockMovie = (slug: string) => ({ id: 1, name: slug, slug, tmdbId: '1', imdbId: null, publishedYear: null });

beforeEach(() => jest.clearAllMocks());

describe('isFilmLink', () => {
  it.each([
    ['/film/heat/', true],
    ['/film/the-thing-1982/', true],
    ['https://letterboxd.com/film/heat/', true],
    // The real offender: promo tiles in Letterboxd's grid carry a bare "/" as their link, which
    // resolved to the homepage and burned a full retry cycle each.
    ['/', false],
    ['', false],
    [undefined, false],
    [null, false],
    ['/films/popular/', false],
    ['/chammerdata/watchlist/', false],
    ['not a url', false],
  ])('%s -> %s', (link, expected) => {
    expect(isFilmLink(link as string | undefined | null)).toBe(expected);
  });
});

describe('resolveMoviesTolerant', () => {
  it('skips a film that fails and returns the rest (one flaky fetch must not abort the list)', async () => {
    (getMovie as jest.Mock).mockImplementation(async (link: string) => {
      if (link === '/film/bad/') throw new Error('fetch failed');
      return mockMovie(link);
    });

    const movies = await resolveMoviesTolerant(['/film/a/', '/film/bad/', '/film/c/']);

    expect(movies.map((m) => m.slug)).toEqual(['/film/a/', '/film/c/']);
    expect(getMovie).toHaveBeenCalledTimes(3);
  });

  it('returns [] for no links without calling getMovie', async () => {
    const movies = await resolveMoviesTolerant([]);
    expect(movies).toEqual([]);
    expect(getMovie).not.toHaveBeenCalled();
  });
});
