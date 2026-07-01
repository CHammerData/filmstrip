import { Fragment, FormEvent, useState } from 'react';
import { get, post, patch, del, ApiError, List, User, SyncResult } from '../api';
import { useLoad } from '../useLoad';
import { useAuth } from '../auth';

export default function Lists() {
  const { me } = useAuth();
  const lists = useLoad<List[]>(() => get('/lists'));
  const users = useLoad<User[]>(() => (me?.isAdmin ? get('/users') : Promise.resolve([])));
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function syncNow(id: number) {
    setNotice(null);
    setError(null);
    try {
      const r = await post<SyncResult>(`/lists/${id}/sync`);
      setNotice(`Sync ${r.status}: found ${r.found}, added ${r.added}, skipped ${r.skipped}, failed ${r.failed}.`);
      lists.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Sync failed.');
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this list? Films it added stay in Radarr until reconciled.')) return;
    try {
      await del(`/lists/${id}`);
      lists.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed.');
    }
  }

  return (
    <div>
      <h1>Lists</h1>
      {notice && <div className="panel" style={{ borderColor: 'var(--ok)' }}>{notice}</div>}
      {error && <div className="error">{error}</div>}

      {me?.isAdmin && <AddList users={users.data ?? []} onAdded={lists.reload} />}

      {lists.loading && <p className="muted">Loading…</p>}
      {lists.error && <div className="error">{lists.error}</div>}
      {lists.data && lists.data.length === 0 && <p className="muted">No lists yet.</p>}

      {lists.data && lists.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Type</th>
              <th>Owner</th>
              <th>Enabled</th>
              <th>Last synced</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lists.data.map((l) => (
              <Fragment key={l.id}>
                <tr>
                  <td>
                    {l.label}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {l.url}
                    </div>
                  </td>
                  <td>{l.listType}</td>
                  <td>{l.user?.name ?? l.userId}</td>
                  <td>{l.enabled ? 'yes' : 'no'}</td>
                  <td className="muted">{l.lastSyncedAt ? new Date(l.lastSyncedAt).toLocaleString() : 'never'}</td>
                  <td className="actions">
                    <button className="secondary" onClick={() => syncNow(l.id)}>
                      Sync
                    </button>
                    <button className="secondary" onClick={() => setEditing(editing === l.id ? null : l.id)}>
                      Edit
                    </button>
                    {me?.isAdmin && (
                      <button className="danger" onClick={() => remove(l.id)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
                {editing === l.id && (
                  <tr key={`${l.id}-edit`}>
                    <td colSpan={6}>
                      <EditList
                        list={l}
                        onSaved={() => {
                          setEditing(null);
                          lists.reload();
                        }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AddList({ users, onAdded }: { users: User[]; onAdded: () => void }) {
  const [userId, setUserId] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await post('/lists', { userId: Number(userId), url });
      setUrl('');
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add list.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Add a list</h2>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <label>
          <span>Owner</span>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="" disabled>
              Select user…
            </option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 3 }}>
          <span>Letterboxd URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://letterboxd.com/user/watchlist/" required />
        </label>
        <button type="submit" disabled={busy || !userId || !url} style={{ flex: 'none' }}>
          Add
        </button>
      </div>
    </form>
  );
}

function EditList({ list, onSaved }: { list: List; onSaved: () => void }) {
  const [form, setForm] = useState(list);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof List>(key: K, value: List[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await patch(`/lists/${list.id}`, {
        label: form.label,
        enabled: form.enabled,
        monitored: form.monitored,
        deleteFiles: form.deleteFiles,
        permanence: form.permanence,
        unwatchedOnly: form.unwatchedOnly,
        removeOnWatch: form.removeOnWatch,
        makeCollection: form.makeCollection,
        qualityProfile: emptyToNull(form.qualityProfile),
        minimumAvailability: emptyToNull(form.minimumAvailability),
        extraTags: emptyToNull(form.extraTags),
        collectionNameOverride: emptyToNull(form.collectionNameOverride),
        takeAmount: form.takeAmount,
        checkIntervalMin: form.checkIntervalMin,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ background: 'var(--panel-2)' }}>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <label>
          <span>Label</span>
          <input value={form.label} onChange={(e) => set('label', e.target.value)} />
        </label>
        <label>
          <span>Quality profile (blank = default)</span>
          <input value={form.qualityProfile ?? ''} onChange={(e) => set('qualityProfile', e.target.value)} />
        </label>
        <label>
          <span>Min. availability</span>
          <select value={form.minimumAvailability ?? ''} onChange={(e) => set('minimumAvailability', e.target.value)}>
            <option value="">(default)</option>
            <option value="announced">announced</option>
            <option value="inCinemas">inCinemas</option>
            <option value="released">released</option>
          </select>
        </label>
      </div>
      <div className="row">
        <label>
          <span>Extra tags (comma-sep)</span>
          <input value={form.extraTags ?? ''} onChange={(e) => set('extraTags', e.target.value)} />
        </label>
        <label>
          <span>Take amount</span>
          <input
            type="number"
            value={form.takeAmount ?? ''}
            onChange={(e) => set('takeAmount', e.target.value ? Number(e.target.value) : null)}
          />
        </label>
        <label>
          <span>Check interval (min)</span>
          <input
            type="number"
            value={form.checkIntervalMin ?? ''}
            onChange={(e) => set('checkIntervalMin', e.target.value ? Number(e.target.value) : null)}
          />
        </label>
        <label>
          <span>Collection name override</span>
          <input
            value={form.collectionNameOverride ?? ''}
            onChange={(e) => set('collectionNameOverride', e.target.value)}
          />
        </label>
      </div>
      <div className="row" style={{ gap: 20 }}>
        <Toggle label="Enabled" checked={form.enabled} onChange={(v) => set('enabled', v)} />
        <Toggle label="Monitored" checked={form.monitored} onChange={(v) => set('monitored', v)} />
        <Toggle label="Delete files" checked={form.deleteFiles} onChange={(v) => set('deleteFiles', v)} />
        <Toggle label="Permanence (keep on delete)" checked={form.permanence} onChange={(v) => set('permanence', v)} />
        <Toggle label="Unwatched only" checked={form.unwatchedOnly} onChange={(v) => set('unwatchedOnly', v)} />
        <Toggle label="Remove on watch" checked={form.removeOnWatch} onChange={(v) => set('removeOnWatch', v)} />
        <Toggle label="Make collection" checked={form.makeCollection} onChange={(v) => set('makeCollection', v)} />
      </div>
      <button onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 'none', margin: 0 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 'auto' }}
      />
      <span style={{ margin: 0 }}>{label}</span>
    </label>
  );
}

function emptyToNull(v: string | null): string | null {
  return v && v.trim() !== '' ? v : null;
}
