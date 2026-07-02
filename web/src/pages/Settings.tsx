import { useState } from 'react';
import { get, patch, post, ApiError, Settings as SettingsType, SyncResult } from '../api';
import { useLoad } from '../useLoad';

export default function Settings() {
  const settings = useLoad<SettingsType>(() => get('/settings'));

  return (
    <div>
      <h1>Settings</h1>
      {settings.loading && <p className="muted">Loading…</p>}
      {settings.error && <div className="error">{settings.error}</div>}
      {settings.data && <SettingsForm initial={settings.data} onSaved={settings.reload} />}
      <SyncAll />
    </div>
  );
}

function SettingsForm({ initial, onSaved }: { initial: SettingsType; onSaved: () => void }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof SettingsType>(key: K, value: SettingsType[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await patch('/settings', {
        radarrUrl: form.radarrUrl || null,
        radarrApiKey: form.radarrApiKey || null,
        jellyfinUrl: form.jellyfinUrl || null,
        jellyfinApiKey: form.jellyfinApiKey || null,
        defaultQualityProfile: form.defaultQualityProfile || null,
        defaultMinimumAvailability: form.defaultMinimumAvailability,
        defaultCheckIntervalMin: form.defaultCheckIntervalMin,
        dryRun: form.dryRun,
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      {error && <div className="error">{error}</div>}

      <h2>Radarr</h2>
      <div className="row">
        <label>
          <span>URL</span>
          <input value={form.radarrUrl ?? ''} onChange={(e) => set('radarrUrl', e.target.value)} placeholder="http://radarr:7878" />
        </label>
        <label>
          <span>API key</span>
          <input value={form.radarrApiKey ?? ''} onChange={(e) => set('radarrApiKey', e.target.value)} />
        </label>
      </div>

      <h2>Jellyfin</h2>
      <div className="row">
        <label>
          <span>URL</span>
          <input value={form.jellyfinUrl ?? ''} onChange={(e) => set('jellyfinUrl', e.target.value)} placeholder="http://jellyfin:8096" />
        </label>
        <label>
          <span>API key</span>
          <input value={form.jellyfinApiKey ?? ''} onChange={(e) => set('jellyfinApiKey', e.target.value)} />
        </label>
      </div>

      <h2>Defaults</h2>
      <div className="row">
        <label>
          <span>Quality profile</span>
          <input
            value={form.defaultQualityProfile ?? ''}
            onChange={(e) => set('defaultQualityProfile', e.target.value)}
            placeholder="HD-1080p"
          />
        </label>
        <label>
          <span>Min. availability</span>
          <select
            value={form.defaultMinimumAvailability}
            onChange={(e) => set('defaultMinimumAvailability', e.target.value)}
          >
            <option value="announced">announced</option>
            <option value="inCinemas">inCinemas</option>
            <option value="released">released</option>
          </select>
        </label>
        <label>
          <span>Check interval (min)</span>
          <input
            type="number"
            value={form.defaultCheckIntervalMin}
            onChange={(e) => set('defaultCheckIntervalMin', Number(e.target.value))}
          />
        </label>
      </div>

      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={form.dryRun} onChange={(e) => set('dryRun', e.target.checked)} style={{ width: 'auto' }} />
        <span style={{ margin: 0 }}>Dry run (log what would change; make no Radarr edits)</span>
      </label>

      <button onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
      {saved && <span className="muted" style={{ marginLeft: 10 }}>Saved.</span>}
    </div>
  );
}

function SyncAll() {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(due: boolean) {
    setNotice(null);
    setError(null);
    setBusy(true);
    try {
      const results = await post<SyncResult[]>(`/sync${due ? '?due=true' : ''}`);
      setNotice(`Synced ${results.length} list(s).`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Run a sync now</h2>
      {notice && <p style={{ color: 'var(--ok)' }}>{notice}</p>}
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button onClick={() => run(false)} disabled={busy}>
          Sync all enabled lists
        </button>
        <button className="secondary" onClick={() => run(true)} disabled={busy}>
          Sync only due lists
        </button>
      </div>
    </div>
  );
}
