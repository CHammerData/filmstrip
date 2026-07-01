import { get, SyncRun } from '../api';
import { useLoad } from '../useLoad';

export default function SyncHistory() {
  const runs = useLoad<SyncRun[]>(() => get('/sync-runs?limit=100'));

  return (
    <div>
      <h1>Sync history</h1>
      {runs.loading && <p className="muted">Loading…</p>}
      {runs.error && <div className="error">{runs.error}</div>}
      {runs.data && runs.data.length === 0 && <p className="muted">No syncs yet.</p>}

      {runs.data && runs.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>List</th>
              <th>Status</th>
              <th>Started</th>
              <th>Found</th>
              <th>Added</th>
              <th>Skipped</th>
              <th>Failed</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((r) => (
              <tr key={r.id}>
                <td>{r.listId}</td>
                <td>
                  <span className={`pill ${r.status === 'success' ? 'ok' : r.status === 'failed' ? 'fail' : ''}`}>
                    {r.status}
                    {r.dryRun ? ' (dry)' : ''}
                  </span>
                </td>
                <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
                <td>{r.moviesFound}</td>
                <td>{r.moviesAdded}</td>
                <td>{r.moviesSkipped}</td>
                <td>{r.moviesFailed}</td>
                <td className="muted">{r.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
