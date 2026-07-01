import { resolveListConfig, ListWithUser, GLOBAL_TAG } from './config';
import { List, Settings, User } from '@prisma/client';

const now = new Date('2026-01-01T00:00:00Z');

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    id: 1,
    radarrUrl: 'http://radarr:7878',
    radarrApiKey: 'key',
    jellyfinUrl: null,
    jellyfinApiKey: null,
    defaultQualityProfile: 'HD-1080p',
    defaultRootFolderId: null,
    defaultMinimumAvailability: 'released',
    defaultCheckIntervalMin: 60,
    dryRun: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    name: 'Chris',
    tag: 'chris',
    enabled: true,
    letterboxdUsername: null,
    jellyfinUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeList(overrides: Partial<List> = {}, user: User = makeUser()): ListWithUser {
  const list: List = {
    id: 10,
    userId: user.id,
    url: 'https://letterboxd.com/chris/watchlist/',
    listType: 'watchlist',
    label: "Chris's watchlist",
    enabled: true,
    qualityProfile: null,
    rootFolderId: null,
    minimumAvailability: null,
    monitored: true,
    extraTags: null,
    takeAmount: null,
    takeStrategy: null,
    checkIntervalMin: null,
    deleteFiles: true,
    unwatchedOnly: false,
    removeOnWatch: false,
    makeCollection: false,
    collectionNameOverride: null,
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  return { ...list, user };
}

describe('resolveListConfig', () => {
  it('inherits Settings defaults when list overrides are null', () => {
    const config = resolveListConfig(makeList(), makeSettings());
    expect(config.qualityProfile).toBe('HD-1080p');
    expect(config.minimumAvailability).toBe('released');
    expect(config.checkIntervalMin).toBe(60);
    expect(config.rootFolderId).toBeUndefined();
    expect(config.dryRun).toBe(false);
    expect(config.radarrUrl).toBe('http://radarr:7878');
  });

  it('prefers per-list overrides over Settings defaults', () => {
    const config = resolveListConfig(
      makeList({
        qualityProfile: '4K',
        minimumAvailability: 'inCinemas',
        rootFolderId: '3',
        checkIntervalMin: 15,
        takeAmount: 25,
        takeStrategy: 'newest',
      }),
      makeSettings({ defaultRootFolderId: '1' })
    );
    expect(config.qualityProfile).toBe('4K');
    expect(config.minimumAvailability).toBe('inCinemas');
    expect(config.rootFolderId).toBe('3');
    expect(config.checkIntervalMin).toBe(15);
    expect(config.take).toBe(25);
    expect(config.strategy).toBe('newest');
  });

  it('falls back to Settings default root folder when list has none', () => {
    const config = resolveListConfig(makeList(), makeSettings({ defaultRootFolderId: '7' }));
    expect(config.rootFolderId).toBe('7');
  });

  it('assembles tags as [userTag, GLOBAL_TAG, ...extraTags], deduped', () => {
    const config = resolveListConfig(
      makeList({ extraTags: 'horror, chris ,4k, ' }),
      makeSettings()
    );
    expect(config.tags).toEqual(['chris', GLOBAL_TAG, 'horror', '4k']);
  });

  it('treats an invalid takeStrategy as undefined', () => {
    const config = resolveListConfig(makeList({ takeStrategy: 'bogus' }), makeSettings());
    expect(config.strategy).toBeUndefined();
  });

  it('throws when Radarr connection is missing', () => {
    expect(() => resolveListConfig(makeList(), makeSettings({ radarrApiKey: null }))).toThrow(
      /Radarr connection/
    );
  });

  it('throws when neither list nor Settings supply a quality profile', () => {
    expect(() =>
      resolveListConfig(makeList(), makeSettings({ defaultQualityProfile: null }))
    ).toThrow(/quality profile/);
  });

  it('defaults collectionName to the list label, and respects an override', () => {
    expect(resolveListConfig(makeList(), makeSettings()).collectionName).toBe("Chris's watchlist");
    expect(
      resolveListConfig(makeList({ collectionNameOverride: 'Horror Picks' }), makeSettings())
        .collectionName
    ).toBe('Horror Picks');
  });

  it('passes through the watched-state and collection toggles', () => {
    const config = resolveListConfig(
      makeList({ unwatchedOnly: true, removeOnWatch: true, makeCollection: true }),
      makeSettings()
    );
    expect(config.unwatchedOnly).toBe(true);
    expect(config.removeOnWatch).toBe(true);
    expect(config.makeCollection).toBe(true);
  });
});
