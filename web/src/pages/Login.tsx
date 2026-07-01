import { FormEvent, useState } from 'react';
import { useAuth } from '../auth';
import { ApiError } from '../api';

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="panel login" onSubmit={onSubmit}>
        <h1>Filmstrip</h1>
        <p className="muted" style={{ textAlign: 'center', marginTop: 0 }}>
          Sign in with your Jellyfin account.
        </p>
        {error && <div className="error">{error}</div>}
        <label>
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label>
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || !username || !password} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
