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

describe('resolveMoviesTolerant with a film cache', () => {
  /** A FilmCache backed by a plain Map, so these tests never touch prisma. */
  function fakeCache(seed: string[] = []) {
    const store = new Map(seed.map((slug) => [slug, mockMovie(slug)]));
    return {
      store,
      getMany: jest.fn(async (slugs: string[]) => {
        const hits = new Map<string, ReturnType<typeof mockMovie>>();
        for (const s of slugs) {
          const hit = store.get(s);
          if (hit) hits.set(s, hit);
        }
        return hits;
      }),
      putMany: jest.fn(async (movies: ReturnType<typeof mockMovie>[]) => {
        for (const m of movies) store.set(m.slug, m);
      }),
    };
  }

  it('fetches only the films the cache does not already know', async () => {
    const cache = fakeCache(['/film/a/']);
    (getMovie as jest.Mock).mockImplementation(async (link: string) => mockMovie(link));

    const movies = await resolveMoviesTolerant(['/film/a/', '/film/b/'], {}, cache);

    expect(getMovie).toHaveBeenCalledTimes(1);
    expect(getMovie).toHaveBeenCalledWith('/film/b/', {});
    expect(movies.map((m) => m.slug)).toEqual(['/film/a/', '/film/b/']); // caller's order preserved
  });

  it('writes newly resolved films back to the cache', async () => {
    const cache = fakeCache();
    (getMovie as jest.Mock).mockImplementation(async (link: string) => mockMovie(link));

    await resolveMoviesTolerant(['/film/a/'], {}, cache);

    expect(cache.putMany).toHaveBeenCalledWith([expect.objectContaining({ slug: '/film/a/' })]);
  });

  it('skips the network entirely when every film is cached', async () => {
    const cache = fakeCache(['/film/a/', '/film/b/']);

    const movies = await resolveMoviesTolerant(['/film/a/', '/film/b/'], {}, cache);

    expect(getMovie).not.toHaveBeenCalled();
    expect(movies).toHaveLength(2);
  });

  it('still resolves everything when no cache is supplied', async () => {
    (getMovie as jest.Mock).mockImplementation(async (link: string) => mockMovie(link));

    const movies = await resolveMoviesTolerant(['/film/a/', '/film/b/']);

    expect(getMovie).toHaveBeenCalledTimes(2);
    expect(movies).toHaveLength(2);
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
