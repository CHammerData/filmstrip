// Shared per-list settings form used by both "Add a list" (advanced section) and "Edit list", so
// the fields, help text, and Radarr-populated dropdowns stay in sync in one place.
import { RadarrOptions } from './api';

/** The editable subset of a List. `List` is structurally a superset, so it satisfies this too. */
export interface ListSettingsForm {
  label: string;
  enabled: boolean;
  qualityProfile: string | null;
  rootFolderId: string | null;
  minimumAvailability: string | null;
  monitored: boolean;
  extraTags: string | null;
  takeAmount: number | null;
  takeStrategy: string | null;
  checkIntervalMin: number | null;
  deleteFiles: boolean;
  permanence: boolean;
  unwatchedOnly: boolean;
  removeOnWatch: boolean;
  makeCollection: boolean;
  collectionNameOverride: string | null;
}

/** Sensible blank starting point for the Add form (all overrides null => inherit Settings). */
export const EMPTY_LIST_SETTINGS: ListSettingsForm = {
  label: '',
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
  permanence: false,
  unwatchedOnly: false,
  removeOnWatch: false,
  makeCollection: false,
  collectionNameOverride: null,
};

/** One-line explanation of each setting, shown as muted help text under its control. */
const FIELD_HELP: Record<string, string> = {
  label: 'Display name for this list in Filmstrip. Blank on add = auto-generated from the owner and list type.',
  qualityProfile: 'Radarr quality profile new films are added with. Blank inherits the Settings default.',
  rootFolderId: 'Radarr root folder films are stored under. Blank inherits the Settings default.',
  minimumAvailability: 'How early Radarr will grab a film: announced, in cinemas, or released. Blank inherits the default.',
  extraTags: 'Extra Radarr tags beyond the owner tag and "letterboxd". Applied to every film this list adds.',
  takeAmount: 'Cap how many films to pull from the list. Blank takes all of them.',
  takeStrategy: 'When capped, which films to take: oldest or newest on the list. Blank uses the scraper default.',
  checkIntervalMin: 'How often (minutes) this list is re-scraped and synced. Blank inherits the Settings default.',
  collectionNameOverride: 'Name for the Jellyfin collection (when "Make collection" is on). Blank uses the list label.',
  enabled: 'When off, this list is skipped by the scheduler and manual syncs.',
  monitored: 'Add films to Radarr as monitored so it searches for and upgrades them.',
  deleteFiles: 'On an approved deletion from this list, also delete the file (not just unmonitor in Radarr).',
  permanence: 'If this list is deleted, keep its films (pin them) instead of queueing them for deletion review.',
  unwatchedOnly: 'Skip films the owner has already watched (Letterboxd + Jellyfin) when adding.',
  removeOnWatch: 'Queue a film for deletion review once the owner watches it, even if it is still on the list.',
  makeCollection: 'Mirror this list into a Jellyfin collection (BoxSet) of its current films.',
};

function Help({ field }: { field: string }) {
  const text = FIELD_HELP[field];
  if (!text) return null;
  return <span className="help">{text}</span>;
}

/** Toggle a single tag label in/out of a comma-separated extraTags string. */
function toggleTag(current: string | null, label: string): string | null {
  const parts = (current ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const next = parts.includes(label) ? parts.filter((t) => t !== label) : [...parts, label];
  return next.length > 0 ? next.join(', ') : null;
}

function currentTags(extraTags: string | null): Set<string> {
  return new Set(
    (extraTags ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  );
}

export function ListSettingsFields({
  form,
  set,
  radarrOptions,
}: {
  form: ListSettingsForm;
  set: (patch: Partial<ListSettingsForm>) => void;
  radarrOptions: RadarrOptions | null;
}) {
  const configured = radarrOptions?.configured ?? false;
  const selectedTags = currentTags(form.extraTags);

  return (
    <>
      <div className="settings-grid">
        <label>
          <span>Label</span>
          <input value={form.label} onChange={(e) => set({ label: e.target.value })} />
          <Help field="label" />
        </label>
        <label>
          <span>Quality profile</span>
          {configured ? (
            <select
              value={form.qualityProfile ?? ''}
              onChange={(e) => set({ qualityProfile: e.target.value || null })}
            >
              <option value="">(default)</option>
              {radarrOptions!.qualityProfiles.map((p) => (
                <option key={p.id} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={form.qualityProfile ?? ''}
              onChange={(e) => set({ qualityProfile: e.target.value || null })}
              placeholder="(default)"
            />
          )}
          <Help field="qualityProfile" />
        </label>
        <label>
          <span>Root folder</span>
          {configured ? (
            <select
              value={form.rootFolderId ?? ''}
              onChange={(e) => set({ rootFolderId: e.target.value || null })}
            >
              <option value="">(default)</option>
              {radarrOptions!.rootFolders.map((f) => (
                <option key={f.id} value={String(f.id)}>
                  {f.path}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={form.rootFolderId ?? ''}
              onChange={(e) => set({ rootFolderId: e.target.value || null })}
              placeholder="(default)"
            />
          )}
          <Help field="rootFolderId" />
        </label>
        <label>
          <span>Min. availability</span>
          <select
            value={form.minimumAvailability ?? ''}
            onChange={(e) => set({ minimumAvailability: e.target.value || null })}
          >
            <option value="">(default)</option>
            <option value="announced">announced</option>
            <option value="inCinemas">inCinemas</option>
            <option value="released">released</option>
          </select>
          <Help field="minimumAvailability" />
        </label>
        <label className="span-2">
          <span>Extra tags (comma-separated)</span>
          <input
            value={form.extraTags ?? ''}
            onChange={(e) => set({ extraTags: e.target.value || null })}
            placeholder="e.g. 4k, foreign"
          />
          {configured && radarrOptions!.tags.length > 0 && (
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {radarrOptions!.tags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="secondary"
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    opacity: selectedTags.has(t.label) ? 1 : 0.6,
                  }}
                  onClick={() => set({ extraTags: toggleTag(form.extraTags, t.label) })}
                >
                  {selectedTags.has(t.label) ? '✓ ' : '+ '}
                  {t.label}
                </button>
              ))}
            </span>
          )}
          <Help field="extraTags" />
        </label>
        <label>
          <span>Take amount</span>
          <input
            type="number"
            value={form.takeAmount ?? ''}
            onChange={(e) => set({ takeAmount: e.target.value ? Number(e.target.value) : null })}
          />
          <Help field="takeAmount" />
        </label>
        <label>
          <span>Take strategy</span>
          <select value={form.takeStrategy ?? ''} onChange={(e) => set({ takeStrategy: e.target.value || null })}>
            <option value="">(default)</option>
            <option value="oldest">oldest</option>
            <option value="newest">newest</option>
          </select>
          <Help field="takeStrategy" />
        </label>
        <label>
          <span>Check interval (min)</span>
          <input
            type="number"
            value={form.checkIntervalMin ?? ''}
            onChange={(e) => set({ checkIntervalMin: e.target.value ? Number(e.target.value) : null })}
          />
          <Help field="checkIntervalMin" />
        </label>
        <label className="span-2">
          <span>Collection name override</span>
          <input
            value={form.collectionNameOverride ?? ''}
            onChange={(e) => set({ collectionNameOverride: e.target.value || null })}
          />
          <Help field="collectionNameOverride" />
        </label>
      </div>

      <div className="toggles-grid">
        <ToggleField label="Enabled" field="enabled" checked={form.enabled} onChange={(v) => set({ enabled: v })} />
        <ToggleField label="Monitored" field="monitored" checked={form.monitored} onChange={(v) => set({ monitored: v })} />
        <ToggleField label="Delete files" field="deleteFiles" checked={form.deleteFiles} onChange={(v) => set({ deleteFiles: v })} />
        <ToggleField label="Permanence" field="permanence" checked={form.permanence} onChange={(v) => set({ permanence: v })} />
        <ToggleField label="Unwatched only" field="unwatchedOnly" checked={form.unwatchedOnly} onChange={(v) => set({ unwatchedOnly: v })} />
        <ToggleField label="Remove on watch" field="removeOnWatch" checked={form.removeOnWatch} onChange={(v) => set({ removeOnWatch: v })} />
        <ToggleField label="Make collection" field="makeCollection" checked={form.makeCollection} onChange={(v) => set({ makeCollection: v })} />
      </div>
    </>
  );
}

/** A labeled checkbox with its help text underneath. */
function ToggleField({
  label,
  field,
  checked,
  onChange,
}: {
  label: string;
  field: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ margin: 0 }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text)', fontSize: 14 }}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 'auto' }} />
        <span style={{ margin: 0 }}>{label}</span>
      </span>
      <Help field={field} />
    </label>
  );
}

/** Build the settings payload (nulling empty strings) to send on create/update. */
export function settingsPayload(form: ListSettingsForm): ListSettingsForm {
  return {
    label: form.label,
    enabled: form.enabled,
    qualityProfile: emptyToNull(form.qualityProfile),
    rootFolderId: emptyToNull(form.rootFolderId),
    minimumAvailability: emptyToNull(form.minimumAvailability),
    monitored: form.monitored,
    extraTags: emptyToNull(form.extraTags),
    takeAmount: form.takeAmount,
    takeStrategy: emptyToNull(form.takeStrategy),
    checkIntervalMin: form.checkIntervalMin,
    deleteFiles: form.deleteFiles,
    permanence: form.permanence,
    unwatchedOnly: form.unwatchedOnly,
    removeOnWatch: form.removeOnWatch,
    makeCollection: form.makeCollection,
    collectionNameOverride: emptyToNull(form.collectionNameOverride),
  };
}

export function emptyToNull(v: string | null): string | null {
  return v && v.trim() !== '' ? v : null;
}
