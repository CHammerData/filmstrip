import { fetchWithRetry } from './http';

jest.mock('../util/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

global.fetch = jest.fn();

beforeEach(() => jest.clearAllMocks());

describe('fetchWithRetry', () => {
  it('sends a browser User-Agent', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });
    await fetchWithRetry('https://letterboxd.com/x/');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://letterboxd.com/x/',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.stringContaining('Mozilla/5.0') }) })
    );
  });

  it('retries a thrown network error, then succeeds', async () => {
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await fetchWithRetry('https://letterboxd.com/x/');

    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns a non-403 non-ok response without retrying (status handling is the caller’s job)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404 });

    const res = await fetchWithRetry('https://letterboxd.com/missing/');

    expect(res.status).toBe(404);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 403 (bot-mitigation false-positive), then succeeds', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await fetchWithRetry('https://letterboxd.com/x/');

    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns the last 403 response after exhausting retries, rather than throwing', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 });

    const res = await fetchWithRetry('https://letterboxd.com/x/');

    expect(res.status).toBe(403);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting retries', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchWithRetry('https://letterboxd.com/x/')).rejects.toThrow('fetch failed');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});
