import { Fragment, FormEvent, useState } from 'react';
import {
  get,
  post,
  patch,
  del,
  ApiError,
  User,
  JellyfinCandidates,
  RefreshWatchedStarted,
  RadarrOptions,
  ListAccess,
} from '../api';
import { useLoad } from '../useLoad';

const ACCESS_LABEL: Record<ListAccess, string> = {
  none: 'No lists',
  approval: 'Lists need approval',
  auto: 'Lists sync straight away',
};

const ACCESS_SHORT: Record<ListAccess, string> = { none: 'none', approval: 'approval', auto: 'auto' };

/** Compact summary of a user's list policy for the table (DESIGN.md §9a); the title has it in full. */
function policySummary(u: User): { short: string; full: string } {
  if (u.listAccess === 'none') return { short: 'none', full: ACCESS_LABEL.none };
  const size = u.maxListSize ? `≤${u.maxListSize}` : 'any size';
  const profiles =
    u.qualityProfiles === '*' ? 'any profile' : u.qualityProfiles ? `default + ${u.qualityProfiles}` : 'default profile';
  return {
    short: `${ACCESS_SHORT[u.listAccess]} · ${size}`,
    full: `${ACCESS_LABEL[u.listAccess]} · ${u.maxListSize ? `at most ${u.maxListSize} films` : 'no size cap'} · ${profiles}`,
  };
}

/** Turn a display name into a Radarr-safe tag suggestion (mirrors the server's deriveUniqueTag). */
function slugifyTag(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'user'
  );
}

export default function Users() {
  const users = useLoad<User[]>(() => get('/users'));
  const [editing, setEditing] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: number) {
    if (!confirm('Delete this user? Their lists are removed too.')) return;
    try {
      await del(`/users/${id}`);
      users.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed.');
    }
  }

  // Force this user's watched-state cache to refresh right now, then reconcile every removeOnWatch
  // list they own against it -- rather than waiting for the next scheduled refresh tick (up to
  // Settings.watchedRefreshIntervalMin) and that list's own next sync to notice a watch.
  async function checkWatchedNow(id: number) {
    setNotice(null);
    setError(null);
    setBusyId(id);
    try {
      await post<RefreshWatchedStarted>(`/users/${id}/refresh-watched`);
      // The refresh runs detached on the server -- a full first pass over a large Letterboxd
      // history takes minutes, far longer than any proxy will hold the request open. "Last
      // refreshed" in the table is what confirms it landed.
      setNotice(
        'Watched-state refresh started. It runs in the background — a first pass over a large ' +
          'Letterboxd history can take several minutes. "Last refreshed" updates when it finishes.'
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the watched-state refresh.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1>Users</h1>
      {notice && <div className="panel" style={{ borderColor: 'var(--ok)' }}>{notice}</div>}
      {error && <div className="error">{error}</div>}
      <AddUser onAdded={users.reload} />

      {users.loading && <p className="muted">Loading…</p>}
      {users.error && <div className="error">{users.error}</div>}
      {users.data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Radarr tag</th>
                <th>Letterboxd</th>
                <th>Jellyfin id</th>
                <th>Watched refreshed</th>
                <th>Lists</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <Fragment key={u.id}>
                  <tr>
                    <td>{u.name}</td>
                    <td>{u.tag}</td>
                    <td className="muted">{u.letterboxdUsername ?? '—'}</td>
                    <td className="muted">{u.jellyfinUserId ?? '—'}</td>
                    {/* The refresh runs detached, so this is how you see it actually finish. */}
                    <td className="muted">
                      {u.lastWatchedRefreshAt ? new Date(u.lastWatchedRefreshAt).toLocaleString() : 'never'}
                    </td>
                    <td className="muted" title={policySummary(u).full} style={{ whiteSpace: 'nowrap' }}>
                      {policySummary(u).short}
                    </td>
                    <td>{u.enabled ? 'yes' : 'no'}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="secondary"
                          onClick={() => checkWatchedNow(u.id)}
                          disabled={busyId === u.id || (!u.letterboxdUsername && !u.jellyfinUserId)}
                          title={
                            u.letterboxdUsername || u.jellyfinUserId
                              ? 'Refresh this user’s watched-state cache now and reconcile removeOnWatch lists'
                              : 'Link a Letterboxd username or Jellyfin account first — there’s nothing to check yet'
                          }
                        >
                          {busyId === u.id ? 'Checking…' : 'Check watched'}
                        </button>
                        <button className="secondary" onClick={() => setEditing(editing === u.id ? null : u.id)}>
                          Edit
                        </button>
                        <button className="danger" onClick={() => remove(u.id)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                  {editing === u.id && (
                    <tr>
                      <td colSpan={8}>
                        <EditUser
                          user={u}
                          onSaved={() => {
                            setEditing(null);
                            users.reload();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddUser({ onAdded }: { onAdded: () => void }) {
  const candidates = useLoad<JellyfinCandidates>(() => get('/jellyfin/users'));
  const [jellyfinUserId, setJellyfinUserId] = useState('');
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [tagEdited, setTagEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const configured = candidates.data?.configured ?? false;
  // Configured but the server couldn't be reached: don't offer free-text entry (it would create a
  // user with no jellyfinUserId — the forked duplicate the picker exists to prevent). Offer a retry.
  const unreachable = configured && candidates.data?.reachable === false;

  function selectCandidate(id: string) {
    setJellyfinUserId(id);
    const c = candidates.data?.users.find((u) => u.id === id);
    if (c) {
      setName(c.name);
      if (!tagEdited) setTag(slugifyTag(c.name)); // keep an admin-typed tag; else suggest one
    }
  }

  function reset() {
    setJellyfinUserId('');
    setName('');
    setTag('');
    setTagEdited(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name, tag };
      if (configured && jellyfinUserId) body.jellyfinUserId = jellyfinUserId;
      await post('/users', body);
      reset();
      onAdded();
      candidates.reload(); // the new user now shows as "already added"
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add user.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Add a user</h2>
      {error && <div className="error">{error}</div>}
      {candidates.loading && <p className="muted">Loading Jellyfin users…</p>}

      {unreachable ? (
        <div>
          <p className="muted" style={{ fontSize: 12 }}>
            Jellyfin is configured but couldn’t be reached, so its account list is unavailable. Fix
            the connection in Settings and retry — adding users manually here would create accounts
            that can’t log in.
          </p>
          <button type="button" className="secondary" onClick={() => candidates.reload()}>
            Retry
          </button>
        </div>
      ) : configured ? (
        <div className="row">
          <label style={{ flex: 2 }}>
            <span>Jellyfin user</span>
            <select value={jellyfinUserId} onChange={(e) => selectCandidate(e.target.value)} required>
              <option value="" disabled>
                Select a Jellyfin user…
              </option>
              {candidates.data!.users.map((u) => (
                <option key={u.id} value={u.id} disabled={u.linked}>
                  {u.name}
                  {u.isAdmin ? ' (admin)' : ''}
                  {u.linked ? ' — already added' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Radarr tag</span>
            <input
              value={tag}
              onChange={(e) => {
                setTag(e.target.value);
                setTagEdited(true);
              }}
              placeholder="e.g. chris"
              required
            />
          </label>
          <button type="submit" disabled={busy || !jellyfinUserId || !tag} style={{ flex: 'none' }}>
            Add
          </button>
        </div>
      ) : (
        <>
          {!candidates.loading && (
            <p className="muted" style={{ fontSize: 12 }}>
              Jellyfin isn’t connected, so users are added manually — they can’t log in until you set
              their Jellyfin id (Edit). Connect Jellyfin in Settings to pick from real accounts.
            </p>
          )}
          <div className="row">
            <label>
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              <span>Radarr tag</span>
              <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. chris" required />
            </label>
            <button type="submit" disabled={busy || !name || !tag} style={{ flex: 'none' }}>
              Add
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function EditUser({ user, onSaved }: { user: User; onSaved: () => void }) {
  const radarr = useLoad<RadarrOptions>(() => get('/radarr/options'));
  const [form, setForm] = useState(user);
  const anyProfile = form.qualityProfiles === '*';
  const picked = new Set(
    anyProfile ? [] : (form.qualityProfiles ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  );

  function toggleProfile(name: string, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(name);
    else next.delete(name);
    setForm({ ...form, qualityProfiles: next.size ? [...next].join(',') : null });
  }
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await patch(`/users/${user.id}`, {
        name: form.name,
        tag: form.tag,
        enabled: form.enabled,
        letterboxdUsername: form.letterboxdUsername || null,
        jellyfinUserId: form.jellyfinUserId || null,
        listAccess: form.listAccess,
        qualityProfiles: form.qualityProfiles,
        maxListSize: form.maxListSize,
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
          <span>Name</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          <span>Radarr tag</span>
          <input value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} />
        </label>
        <label>
          <span>Letterboxd username</span>
          <input
            value={form.letterboxdUsername ?? ''}
            onChange={(e) => setForm({ ...form, letterboxdUsername: e.target.value })}
          />
        </label>
        <label>
          <span>Jellyfin user id</span>
          <input
            value={form.jellyfinUserId ?? ''}
            onChange={(e) => setForm({ ...form, jellyfinUserId: e.target.value })}
          />
        </label>
      </div>
      <h3 style={{ marginTop: 16 }}>Letterboxd lists</h3>
      <p className="muted" style={{ fontSize: 12 }}>
        What this user can do with their own lists. An admin account isn’t limited by any of this.
      </p>
      <div className="row">
        <label>
          <span>Adding lists</span>
          <select
            value={form.listAccess}
            onChange={(e) => setForm({ ...form, listAccess: e.target.value as ListAccess })}
          >
            <option value="auto">{ACCESS_LABEL.auto}</option>
            <option value="approval">{ACCESS_LABEL.approval}</option>
            <option value="none">{ACCESS_LABEL.none} (existing lists stop syncing)</option>
          </select>
        </label>
        <label>
          <span>Max films per list</span>
          <input
            type="number"
            min={1}
            value={form.maxListSize ?? ''}
            placeholder="no cap"
            onChange={(e) => setForm({ ...form, maxListSize: e.target.value ? Number(e.target.value) : null })}
          />
        </label>
      </div>
      <fieldset style={{ border: 'none', padding: 0, margin: '8px 0' }}>
        <span>Quality profiles they can choose (the default is always allowed)</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={anyProfile}
              onChange={(e) => setForm({ ...form, qualityProfiles: e.target.checked ? '*' : null })}
              style={{ width: 'auto' }}
            />
            <span style={{ margin: 0 }}>Any</span>
          </label>
          {!anyProfile && !radarr.data?.configured && (
            <input
              value={form.qualityProfiles ?? ''}
              onChange={(e) => setForm({ ...form, qualityProfiles: e.target.value || null })}
              placeholder="Radarr isn’t reachable: comma-separated profile names"
              style={{ flex: 1, minWidth: 240 }}
            />
          )}
          {!anyProfile &&
            radarr.data?.configured &&
            radarr.data.qualityProfiles.map((p) => (
              <label key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={picked.has(p.name)}
                  onChange={(e) => toggleProfile(p.name, e.target.checked)}
                  style={{ width: 'auto' }}
                />
                <span style={{ margin: 0 }}>{p.name}</span>
              </label>
            ))}
        </div>
      </fieldset>

      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          style={{ width: 'auto' }}
        />
        <span style={{ margin: 0 }}>Enabled</span>
      </label>
      <button onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
