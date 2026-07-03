import { isHttpUrl } from './url';

describe('isHttpUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(isHttpUrl('http://radarr:7878')).toBe(true);
    expect(isHttpUrl('https://jellyfin.magi-home.xyz')).toBe(true);
    expect(isHttpUrl('http://localhost:8096/')).toBe(true);
  });

  it('rejects a schemeless host (the bug that masqueraded as bad credentials)', () => {
    expect(isHttpUrl('radarr.magi-home.xyz')).toBe(false);
    expect(isHttpUrl('jellyfin:8096')).toBe(false); // parses as protocol "jellyfin:", not http(s)
  });

  it('rejects non-http(s) schemes and junk', () => {
    expect(isHttpUrl('ftp://host/f')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});
