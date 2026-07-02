import { useState } from 'react';
import { get, post, ApiError, DeletionRequest } from '../api';
import { useLoad } from '../useLoad';

const STATUSES = ['pending', 'approved', 'kept'] as const;

export default function Deletions() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('pending');
  const reqs = useLoad<DeletionRequest[]>(() => get(`/deletions?status=${status}`), [status]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function resolve(id: number, action: 'approve' | 'keep') {
    setError(null);
    setBusyId(id);
    try {
      await post(`/deletions/${id}/${action}`);
      reqs.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1>Deletion queue</h1>
      <p className="muted">
        Films that left every list Filmstrip added them from (or that the owner watched, with
        <em> remove-on-watch</em>). Approve to delete from Radarr, or keep to pin forever.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <label style={{ flex: 'none', width: 200 }}>
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <div className="error">{error}</div>}
      {reqs.loading && <p className="muted">Loading…</p>}
      {reqs.error && <div className="error">{reqs.error}</div>}
      {reqs.data && reqs.data.length === 0 && <p className="muted">Nothing {status}.</p>}

      {reqs.data && reqs.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Film</th>
              <th>Reason</th>
              <th>Triggered by</th>
              <th>Since</th>
              {status === 'pending' && <th></th>}
            </tr>
          </thead>
          <tbody>
            {reqs.data.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.movie.title}
                  {r.movie.year ? ` (${r.movie.year})` : ''}
                  <div className="muted" style={{ fontSize: 12 }}>
                    tmdb {r.movie.tmdbId}
                  </div>
                </td>
                <td>{r.reason}</td>
                <td className="muted">{r.triggeredByList?.label ?? '—'}</td>
                <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                {status === 'pending' && (
                  <td className="actions">
                    <button disabled={busyId === r.id} onClick={() => resolve(r.id, 'approve')}>
                      Approve
                    </button>
                    <button className="secondary" disabled={busyId === r.id} onClick={() => resolve(r.id, 'keep')}>
                      Keep
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
