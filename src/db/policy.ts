import { List, Settings, User } from '@prisma/client';

/**
 * Per-user list policy (DESIGN.md §9a). The lists API checks it for non-admin sessions; the
 * scheduler applies the parts that matter at sync time (approval, access, profile, size cap) to
 * everyone, so tightening a user's policy reaches lists they already have.
 */

export const LIST_ACCESS = ['none', 'approval', 'auto'] as const;
export type ListAccess = (typeof LIST_ACCESS)[number];

export const LIST_APPROVAL = ['pending', 'approved', 'rejected'] as const;
export type ListApproval = (typeof LIST_APPROVAL)[number];

type PolicyUser = Pick<User, 'listAccess' | 'qualityProfiles' | 'maxListSize'>;

/** The profile names this user may pick, `'*'` for any. An empty array means the Settings default
 *  only (the list's own qualityProfile must be left blank). */
export function allowedQualityProfiles(user: PolicyUser): '*' | string[] {
  const raw = user.qualityProfiles?.trim();
  if (!raw) return [];
  if (raw === '*') return '*';
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Can this user put `profile` on a list? Blank (inherit) and the Settings default are always fine. */
export function isQualityProfileAllowed(
  user: PolicyUser,
  profile: string | null | undefined,
  settings: Pick<Settings, 'defaultQualityProfile'> | null
): boolean {
  if (!profile || profile === settings?.defaultQualityProfile) return true;
  const allowed = allowedQualityProfiles(user);
  return allowed === '*' || allowed.includes(profile);
}

/** How many films a list may take, after the owner's cap. undefined = everything. */
export function effectiveTake(user: PolicyUser, takeAmount: number | null): number | undefined {
  const cap = user.maxListSize ?? undefined;
  if (cap === undefined) return takeAmount ?? undefined;
  return takeAmount === null ? cap : Math.min(takeAmount, cap);
}

/** Should the scheduler sync this list? Disabled lists/owners are filtered separately. */
export function isListSyncable(list: Pick<List, 'approval'> & { user: Pick<User, 'listAccess'> }): boolean {
  return list.approval === 'approved' && list.user.listAccess !== 'none';
}

/** The approval state a list starts in (or returns to, on a URL change) for this owner. */
export function initialApproval(user: Pick<User, 'listAccess'>, isAdmin: boolean): ListApproval {
  return isAdmin || user.listAccess === 'auto' ? 'approved' : 'pending';
}

/** The policy a newly created user starts with: Settings' new-user defaults, or no limits for an
 *  admin. The User columns' own defaults are the restrictive fallback if this isn't used. */
export function newUserPolicy(
  settings: Pick<Settings, 'newUserListAccess' | 'newUserMaxListSize'> | null,
  isAdmin: boolean
): Pick<User, 'listAccess' | 'qualityProfiles' | 'maxListSize'> {
  if (isAdmin) return { listAccess: 'auto', qualityProfiles: '*', maxListSize: null };
  return {
    listAccess: settings?.newUserListAccess ?? 'approval',
    qualityProfiles: null,
    maxListSize: settings?.newUserMaxListSize ?? null,
  };
}
