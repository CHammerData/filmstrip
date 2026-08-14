import Axios from 'axios';
import { fetchViaFlaresolverr } from './flaresolverr';

jest.mock('../util/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('axios');

const mockedAxios = Axios as jest.Mocked<typeof Axios>;

beforeEach(() => {
  jest.clearAllMocks();
  // isAxiosError is a real helper on the module, not a request method -- keep it working.
  (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(false);
});

describe('fetchViaFlaresolverr', () => {
  it('posts a request.get to /v1 and returns the solved page as a Response', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { status: 'ok', solution: { url: 'https://letterboxd.com/x/page/2/', status: 200, response: '<html>p2</html>' } },
    });

    const res = await fetchViaFlaresolverr({ url: 'http://flaresolverr:8191' }, 'https://letterboxd.com/x/page/2/');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>p2</html>');
    const [endpoint, body] = mockedAxios.post.mock.calls[0];
    expect(endpoint).toBe('http://flaresolverr:8191/v1');
    expect(body).toEqual(expect.objectContaining({ cmd: 'request.get', url: 'https://letterboxd.com/x/page/2/' }));
  });

  it('strips a trailing slash from the configured URL rather than posting to //v1', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { status: 'ok', solution: { url: 'u', status: 200, response: '' } },
    });

    await fetchViaFlaresolverr({ url: 'http://flaresolverr:8191/' }, 'https://letterboxd.com/x/');

    expect(mockedAxios.post.mock.calls[0][0]).toBe('http://flaresolverr:8191/v1');
  });

  it('surfaces the upstream status when the browser itself is refused', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { status: 'ok', solution: { url: 'u', status: 403, response: 'denied' } },
    });

    const res = await fetchViaFlaresolverr({ url: 'http://flaresolverr:8191' }, 'https://letterboxd.com/x/');

    expect(res.status).toBe(403); // a solved-but-403 page is a real answer, not an error
  });

  it('throws when FlareSolverr reports it could not solve the page', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { status: 'error', message: 'Challenge not solved!' } });

    await expect(
      fetchViaFlaresolverr({ url: 'http://flaresolverr:8191' }, 'https://letterboxd.com/x/')
    ).rejects.toThrow('Challenge not solved!');
  });

  it('throws a clear error when FlareSolverr is unreachable', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(
      fetchViaFlaresolverr({ url: 'http://flaresolverr:8191' }, 'https://letterboxd.com/x/')
    ).rejects.toThrow('FlareSolverr request to http://flaresolverr:8191/v1 failed');
  });
});
