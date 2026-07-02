import { List, Settings, User } from '@prisma/client';

/** Tag applied to every movie this tool adds, regardless of user/list. */
export const GLOBAL_TAG = 'letterboxd';

/** A List joined with its owning User (what the scheduler loads per sync). */
export type ListWithUser = List & { user: User };

/**
 * The fully-resolved settings for syncing one list: per-list overrides merged
 * over Settings defaults, plus the assembled tag set. This is the single object
 * the scraper + radarr modules consume — they never read the DB or env directly.
 */
export interface EffectiveListConfig {
  listId: number;
  url: string;
  label: string;
  listType: string;

  // Scraper params (undefined => take everything, upstream default).
  take?: number;
  strategy?: 'oldest' | 'newest';

  // Radarr connection (from Settings).
  radarrUrl: string;
  radarrApiKey: string;

  // Per-movie Radarr options.
  qualityProfile: string;
  rootFolderId?: string;
  minimumAvailability: string;
  monitored: boolean;
  tags: string[];

  // Global behaviour.
  dryRun: boolean;
  checkIntervalMin: number;

  // Watched-state + Jellyfin behaviour (DESIGN.md §7-§8).
  unwatchedOnly: boolean;
  removeOnWatch: boolean;
  makeCollection: boolean;
  collectionName: string;
}

/** Split a comma-separated tag string into trimmed, non-empty parts. */
export function parseExtraTags(extraTags: string | null): string[] {
  if (!extraTags) return [];
  return extraTags
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Merge a List's nullable overrides over the Settings defaults to produce the
 * effective config for one sync. Throws with an actionable message when a
 * required value (Radarr connection, quality profile) is missing entirely.
 */
export function resolveListConfig(list: ListWithUser, settings: Settings): EffectiveListConfig {
  const radarrUrl = settings.radarrUrl;
  const radarrApiKey = settings.radarrApiKey;
  if (!radarrUrl || !radarrApiKey) {
    throw new Error(
      'Radarr connection is not configured. Set radarrUrl and radarrApiKey in Settings.'
    );
  }

  const qualityProfile = list.qualityProfile ?? settings.defaultQualityProfile;
  if (!qualityProfile) {
    throw new Error(
      `No quality profile for list "${list.label}" (id=${list.id}) and no Settings default. ` +
        'Set defaultQualityProfile in Settings or qualityProfile on the list.'
    );
  }

  // user tag + global tag + per-list extras, deduped, order-preserving.
  const tags = [...new Set([list.user.tag, GLOBAL_TAG, ...parseExtraTags(list.extraTags)])];

  const strategy =
    list.takeStrategy === 'oldest' || list.takeStrategy === 'newest'
      ? list.takeStrategy
      : undefined;

  return {
    listId: list.id,
    url: list.url,
    label: list.label,
    listType: list.listType,

    take: list.takeAmount ?? undefined,
    strategy,

    radarrUrl,
    radarrApiKey,

    qualityProfile,
    rootFolderId: list.rootFolderId ?? settings.defaultRootFolderId ?? undefined,
    minimumAvailability: list.minimumAvailability ?? settings.defaultMinimumAvailability,
    monitored: list.monitored,
    tags,

    dryRun: settings.dryRun,
    checkIntervalMin: list.checkIntervalMin ?? settings.defaultCheckIntervalMin,

    unwatchedOnly: list.unwatchedOnly,
    removeOnWatch: list.removeOnWatch,
    makeCollection: list.makeCollection,
    collectionName: list.collectionNameOverride ?? list.label,
  };
}
