import {
  allowedQualityProfiles,
  effectiveTake,
  initialApproval,
  isListSyncable,
  isQualityProfileAllowed,
  newUserPolicy,
} from './policy';

const user = (p: { listAccess?: string; qualityProfiles?: string | null; maxListSize?: number | null } = {}) => ({
  listAccess: 'approval',
  qualityProfiles: null,
  maxListSize: null,
  ...p,
});
const settings = { defaultQualityProfile: 'HD Bluray + WEB' };

describe('allowedQualityProfiles', () => {
  it('reads null as default-only, "*" as any, and a comma list as names', () => {
    expect(allowedQualityProfiles(user())).toEqual([]);
    expect(allowedQualityProfiles(user({ qualityProfiles: '*' }))).toBe('*');
    expect(allowedQualityProfiles(user({ qualityProfiles: ' A , B ,' }))).toEqual(['A', 'B']);
  });
});

describe('isQualityProfileAllowed', () => {
  it('always allows blank and the Settings default', () => {
    expect(isQualityProfileAllowed(user(), null, settings)).toBe(true);
    expect(isQualityProfileAllowed(user(), 'HD Bluray + WEB', settings)).toBe(true);
  });

  it('allows only listed profiles, or any with "*"', () => {
    expect(isQualityProfileAllowed(user(), 'UHD Bluray + WEB', settings)).toBe(false);
    expect(isQualityProfileAllowed(user({ qualityProfiles: 'UHD Bluray + WEB' }), 'UHD Bluray + WEB', settings)).toBe(true);
    expect(isQualityProfileAllowed(user({ qualityProfiles: '*' }), 'Any', settings)).toBe(true);
  });
});

describe('effectiveTake', () => {
  it('caps a list at the owner\'s maximum, including one that would take everything', () => {
    expect(effectiveTake(user(), null)).toBeUndefined();
    expect(effectiveTake(user(), 80)).toBe(80);
    expect(effectiveTake(user({ maxListSize: 50 }), null)).toBe(50);
    expect(effectiveTake(user({ maxListSize: 50 }), 80)).toBe(50);
    expect(effectiveTake(user({ maxListSize: 50 }), 20)).toBe(20);
  });
});

describe('isListSyncable / initialApproval', () => {
  it('syncs only approved lists whose owner may sync', () => {
    expect(isListSyncable({ approval: 'approved', user: { listAccess: 'auto' } })).toBe(true);
    expect(isListSyncable({ approval: 'pending', user: { listAccess: 'auto' } })).toBe(false);
    expect(isListSyncable({ approval: 'approved', user: { listAccess: 'none' } })).toBe(false);
  });

  it('starts a list pending only for a non-admin on "approval"', () => {
    expect(initialApproval({ listAccess: 'approval' }, false)).toBe('pending');
    expect(initialApproval({ listAccess: 'approval' }, true)).toBe('approved');
    expect(initialApproval({ listAccess: 'auto' }, false)).toBe('approved');
  });
});

describe('newUserPolicy', () => {
  it('copies the Settings defaults for a user, and gives an admin no limits', () => {
    const s = { newUserListAccess: 'none', newUserMaxListSize: 30 };
    expect(newUserPolicy(s, false)).toEqual({ listAccess: 'none', qualityProfiles: null, maxListSize: 30 });
    expect(newUserPolicy(s, true)).toEqual({ listAccess: 'auto', qualityProfiles: '*', maxListSize: null });
  });
});
