import { Fragment, FormEvent, useState } from 'react';
import { get, post, patch, del, ApiError, User, JellyfinCandidates } from '../api';
import { useLoad } from '../useLoad';

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

  return (
    <div>
      <h1>Users</h1>
      {error && <div className="error">{error}</div>}
      <AddUser onAdded={users.reload} />

      {users.loading && <p className="muted">Loading…</p>}
      {users.error && <div className="error">{users.error}</div>}
      {users.data && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Radarr tag</th>
              <th>Letterboxd</th>
              <th>Jellyfin id</th>
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
                  <td>{u.enabled ? 'yes' : 'no'}</td>
                  <td className="actions">
                    <button className="secondary" onClick={() => setEditing(editing === u.id ? null : u.id)}>
                      Edit
                    </button>
                    <button className="danger" onClick={() => remove(u.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
                {editing === u.id && (
                  <tr>
                    <td colSpan={6}>
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
  const [form, setForm] = useState(user);
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
