// Shown when a list's owner enables "Unwatched only" / "Remove on watch" but has no Letterboxd
// account linked — those toggles need a watched-history source. Lets an admin add the username
// inline (PATCH /users/:id) without leaving the list form.
import { useState } from 'react';
import { patch, ApiError } from './api';

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
  const [username, setUsername] = useState(user.letterboxdUsername ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const value = username.trim();
    if (!value) {
      setError('Enter a Letterboxd username.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await patch(`/users/${user.id}`, { letterboxdUsername: value });
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
          “Unwatched only” and “Remove on watch” rely on {user.name}’s Letterboxd watched films to
          decide what to skip. Add their Letterboxd username so Filmstrip can read it — otherwise
          these toggles have nothing to go on. You can skip and add it later.
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
