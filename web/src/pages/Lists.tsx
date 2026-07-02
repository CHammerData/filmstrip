import { Fragment, FormEvent, useState } from 'react';
import { get, post, patch, del, ApiError, List, User, SyncResult, RadarrOptions } from '../api';
import { useLoad } from '../useLoad';
import { useAuth } from '../auth';
import {
  ListSettingsFields,
  ListSettingsForm,
  EMPTY_LIST_SETTINGS,
  settingsPayload,
} from '../listFields';
import { LetterboxdPrompt } from '../LetterboxdPrompt';

/** Did this change turn on a toggle that needs a watched-history source? */
function enablesWatchedFeature(patch: Partial<ListSettingsForm>): boolean {
  return patch.unwatchedOnly === true || patch.removeOnWatch === true;
}

export default function Lists() {
  const { me } = useAuth();
  const lists = useLoad<List[]>(() => get('/lists'));
  const users = useLoad<User[]>(() => (me?.isAdmin ? get('/users') : Promise.resolve([])));
  const radarr = useLoad<RadarrOptions>(() => get('/radarr/options'));
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mirrors the backend rule: you can edit/sync a list if you own it, or if you're an admin.
  const canManage = (l: List) => !!me && (me.isAdmin || l.userId === me.user.id);

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

      {me?.isAdmin && (
        <AddList users={users.data ?? []} radarrOptions={radarr.data ?? null} onAdded={lists.reload} />
      )}

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
                    {canManage(l) && (
                      <button className="secondary" onClick={() => syncNow(l.id)}>
                        Sync
                      </button>
                    )}
                    {canManage(l) && (
                      <button className="secondary" onClick={() => setEditing(editing === l.id ? null : l.id)}>
                        Edit
                      </button>
                    )}
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
                        radarrOptions={radarr.data ?? null}
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

function AddList({
  users,
  radarrOptions,
  onAdded,
}: {
  users: User[];
  radarrOptions: RadarrOptions | null;
  onAdded: () => void;
}) {
  const [userId, setUserId] = useState('');
  const [url, setUrl] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [form, setForm] = useState<ListSettingsForm>(EMPTY_LIST_SETTINGS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Letterboxd usernames linked via the prompt this session, so we don't re-prompt after saving.
  const [linked, setLinked] = useState<Record<number, string>>({});
  const [promptUser, setPromptUser] = useState<User | null>(null);

  const owner = users.find((u) => u.id === Number(userId)) ?? null;
  // Letterboxd is the only meaningful "already seen it" signal for these toggles (Jellyfin
  // playback only tells us what to delete after a watch), so prompt whenever it's missing.
  const ownerHasLetterboxd = (u: User | null) => !!(u && (u.letterboxdUsername || linked[u.id]));

  const set = (patch: Partial<ListSettingsForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    if (enablesWatchedFeature(patch) && owner && !ownerHasLetterboxd(owner)) setPromptUser(owner);
  };

  function onOwnerChange(id: string) {
    setUserId(id);
    const u = users.find((x) => x.id === Number(id)) ?? null;
    if ((form.unwatchedOnly || form.removeOnWatch) && u && !ownerHasLetterboxd(u)) setPromptUser(u);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Only send overrides that were actually touched; a blank label lets the backend
      // auto-generate one (createSchema rejects an empty label).
      const { label, ...overrides } = settingsPayload(form);
      const body: Record<string, unknown> = { userId: Number(userId), url, ...overrides };
      if (label.trim()) body.label = label;
      await post('/lists', body);
      setUrl('');
      setForm(EMPTY_LIST_SETTINGS);
      setAdvanced(false);
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
          <select value={userId} onChange={(e) => onOwnerChange(e.target.value)} required>
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

      <button
        type="button"
        className="link"
        onClick={() => setAdvanced((a) => !a)}
        style={{ marginTop: 4 }}
      >
        {advanced ? '▾ Advanced settings' : '▸ Advanced settings'}
      </button>

      {advanced && (
        <div style={{ marginTop: 12 }}>
          {radarrOptions && !radarrOptions.configured && (
            <p className="muted" style={{ fontSize: 12 }}>
              Radarr isn’t connected, so profile/folder/tags are free-text. Connect it in Settings for
              dropdowns.
            </p>
          )}
          <ListSettingsFields form={form} set={set} radarrOptions={radarrOptions} />
        </div>
      )}

      {promptUser && (
        <LetterboxdPrompt
          user={promptUser}
          onSaved={(username) => {
            setLinked((m) => ({ ...m, [promptUser!.id]: username }));
            setPromptUser(null);
          }}
          onClose={() => setPromptUser(null)}
        />
      )}
    </form>
  );
}

function EditList({
  list,
  radarrOptions,
  onSaved,
}: {
  list: List;
  radarrOptions: RadarrOptions | null;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ListSettingsForm>(list);
  const [owner, setOwner] = useState<User | null>(list.user ?? null);
  const [prompt, setPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ownerHasLetterboxd = !!(owner && owner.letterboxdUsername);

  const set = (patch: Partial<ListSettingsForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    if (enablesWatchedFeature(patch) && owner && !ownerHasLetterboxd) setPrompt(true);
  };

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await patch(`/lists/${list.id}`, settingsPayload(form));
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
      {radarrOptions && !radarrOptions.configured && (
        <p className="muted" style={{ fontSize: 12 }}>
          Radarr isn’t connected, so profile/folder/tags are free-text. Connect it in Settings for
          dropdowns.
        </p>
      )}
      <ListSettingsFields form={form} set={set} radarrOptions={radarrOptions} />
      <button onClick={save} disabled={busy} style={{ marginTop: 12 }}>
        {busy ? 'Saving…' : 'Save'}
      </button>

      {prompt && owner && (
        <LetterboxdPrompt
          user={owner}
          onSaved={(username) => {
            setOwner({ ...owner!, letterboxdUsername: username });
            setPrompt(false);
          }}
          onClose={() => setPrompt(false)}
        />
      )}
    </div>
  );
}
