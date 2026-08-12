import { fetchWithRetry } from './http';

jest.mock('../util/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: unknown[]) => mockExecFile(...args) }));

const mockReadFile = jest.fn();
const mockRm = jest.fn();
jest.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  rm: (...args: unknown[]) => mockRm(...args),
}));

global.fetch = jest.fn();

/** Configure the mocked curl subprocess to "succeed" with the given status/body. */
function mockCurlResult(status: number, body: string) {
  mockExecFile.mockImplementation((_file, _args, callback) => {
    callback(null, { stdout: String(status), stderr: '' });
  });
  mockReadFile.mockResolvedValue(body);
  mockRm.mockResolvedValue(undefined);
}

beforeEach(() => jest.clearAllMocks());

describe('fetchWithRetry', () => {
  it('sends a browser User-Agent', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200 });
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
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('falls back to curl immediately on a 403, without retrying via fetch first', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 403 });
    mockCurlResult(200, '<html>ok</html>');

    const res = await fetchWithRetry('https://letterboxd.com/chammerdata/films/page/2/');

    expect(global.fetch).toHaveBeenCalledTimes(1); // no fetch retries burned on a 403
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>ok</html>');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, args] = mockExecFile.mock.calls[0];
    expect(file).toBe('curl');
    expect(args).toEqual(expect.arrayContaining(['https://letterboxd.com/chammerdata/films/page/2/']));
    expect(args).toEqual(expect.arrayContaining(['-H', expect.stringContaining('Mozilla/5.0')]));
  });

  it('retries curl-only (no repeat fetch) when curl itself also comes back 403, and succeeds on a later attempt', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 });
    mockExecFile
      .mockImplementationOnce((_file, _args, callback) => callback(null, { stdout: '403', stderr: '' }))
      .mockImplementationOnce((_file, _args, callback) => callback(null, { stdout: '200', stderr: '' }));
    mockReadFile.mockResolvedValueOnce('').mockResolvedValueOnce('<html>ok</html>');
    mockRm.mockResolvedValue(undefined);

    const res = await fetchWithRetry('https://letterboxd.com/x/diary/');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>ok</html>');
    // fetch is confirmed blocked on the first 403 and never retried -- repeating it appeared to
    // re-trigger the same block that then also caught the curl call riding right behind it.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('surfaces the last 403 after curl fails on every attempt, without ever repeating fetch', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 });
    mockCurlResult(403, '');

    const res = await fetchWithRetry('https://letterboxd.com/x/diary/');

    expect(res.status).toBe(403);
    expect(global.fetch).toHaveBeenCalledTimes(1); // blocked once, never retried
    expect(mockExecFile).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS, curl-only after the first 403
  });

  it('cleans up the temp file after reading it', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 403 });
    mockCurlResult(200, 'body');

    await fetchWithRetry('https://letterboxd.com/x/');

    expect(mockRm).toHaveBeenCalledWith(expect.any(String), { force: true });
  });

  it('throws the last error after exhausting retries', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchWithRetry('https://letterboxd.com/x/')).rejects.toThrow('fetch failed');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});
