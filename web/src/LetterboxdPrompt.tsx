// Shown when a list's owner enables "Unwatched only" / "Remove on watch" but has no Letterboxd
// account linked — those toggles need a watched-history source. Saves the username inline without
// leaving the list form: the owner setting their own uses the self-service PATCH /me; an admin
// setting it for someone else uses the admin-only PATCH /users/:id.
import { useState } from 'react';
import { patch, ApiError } from './api';
import { useAuth } from './auth';

export interface PromptUser {
  id: number;
  name: string;
  letterboxdUsername: string | null;
}

export function LetterboxdPrompt({
  user,
  onSaved,
  onClose,
}: {
  user: PromptUser;
  onSaved: (username: string) => void;
  onClose: () => void;
}) {
  const { me } = useAuth();
  const [username, setUsername] = useState(user.letterboxdUsername ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Setting your own username goes through the self-service endpoint (works for non-admins);
  // an admin filling it in for another user uses the admin-only users endpoint.
  const isSelf = me?.user.id === user.id;

  async function save() {
    const value = username.trim();
    if (!value) {
      setError('Enter a Letterboxd username.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await patch(isSelf ? '/me' : `/users/${user.id}`, { letterboxdUsername: value });
      onSaved(value);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Link a Letterboxd account</h2>
        <p className="muted">
          “Unwatched only” and “Remove on watch” rely on {isSelf ? 'your' : `${user.name}’s`}{' '}
          Letterboxd watched films to decide what to skip. Add {isSelf ? 'your' : 'their'} Letterboxd
          username so Filmstrip can read it — otherwise these toggles have nothing to go on. You can
          skip and add it later.
        </p>
        {error && <div className="error">{error}</div>}
        <label>
          <span>Letterboxd username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. davesmith"
            autoFocus
          />
        </label>
        <div className="actions" style={{ marginTop: 12 }}>
          <button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save username'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
