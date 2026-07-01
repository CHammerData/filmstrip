import { Fragment, FormEvent, useState } from 'react';
import { get, post, patch, del, ApiError, User } from '../api';
import { useLoad } from '../useLoad';

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
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await post('/users', { name, tag });
      setName('');
      setTag('');
      onAdded();
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
