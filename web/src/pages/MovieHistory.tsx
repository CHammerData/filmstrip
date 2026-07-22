import { Link, useParams } from 'react-router-dom';
import { get, MovieEventType, MovieHistory as MovieHistoryData } from '../api';
import { useLoad } from '../useLoad';
import { StateBadge } from '../movieState';

// Readable labels for the raw MovieEvent.type values (DESIGN.md §4).
const EVENT_LABELS: Record<MovieEventType, string> = {
  seen_on_list: 'Seen on list',
  left_list: 'Left list',
  restored_to_list: 'Restored to list',
  radarr_add_failed: 'Radarr add failed',
  added_to_radarr: 'Added to Radarr',
  already_in_radarr: 'Already in Radarr',
  deletion_queued: 'Queued for deletion',
  deletion_queue_cancelled: 'Deletion cancelled',
  deleted: 'Deleted',
  kept: 'Kept',
  revived: 'Revived',
  backfilled: 'Backfilled (migration)',
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function MovieHistory() {
  const { id } = useParams<{ id: string }>();
  const history = useLoad<MovieHistoryData>(() => get(`/movies/${id}/history`), [id]);

  return (
    <div>
      <p className="muted" style={{ marginBottom: 4 }}>
        <Link to="/movies">← Movies</Link>
      </p>

      {history.loading && <p className="muted">Loading…</p>}
      {history.error && <div className="error">{history.error}</div>}

      {history.data && (
        <>
          <h1>
            {history.data.movie.title}
            {history.data.movie.year ? ` (${history.data.movie.year})` : ''}
          </h1>
          <p className="muted" style={{ marginBottom: 16 }}>
            tmdb {history.data.movie.tmdbId} · <StateBadge state={history.data.movie.state} />
          </p>

          {history.data.events.length === 0 ? (
            <p className="muted">No history recorded for this film yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>List</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {history.data.events.map((e) => (
                  <tr key={e.id}>
                    <td className="muted">{formatWhen(e.createdAt)}</td>
                    <td>{EVENT_LABELS[e.type] ?? e.type}</td>
                    <td className="muted">{e.listLabel ?? '—'}</td>
                    <td className="muted">{e.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
