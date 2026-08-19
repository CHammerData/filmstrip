import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, ApiError, ConvertToManagedResult, MovieEventType, MovieHistory as MovieHistoryData } from '../api';
import { useLoad } from '../useLoad';
import { StateBadge } from '../movieState';
import { useAuth } from '../auth';

// Readable labels for the raw MovieEvent.type values (DESIGN.md §4).
const EVENT_LABELS: Record<MovieEventType, string> = {
  seen_on_list: 'Seen on list',
  left_list: 'Left list',
  list_deleted: 'List deleted',
  list_deactivated: 'List disabled',
  watch_dropped: 'Dropped on watch',
  restored_to_list: 'Restored to list',
  radarr_add_failed: 'Radarr add failed',
  added_to_radarr: 'Added to Radarr',
  already_in_radarr: 'Already in Radarr',
  converted_to_managed: 'Converted to Filmstrip control',
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
  const { me } = useAuth();
  const [dropError, setDropError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [convertResult, setConvertResult] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  async function dropKeep() {
    setDropError(null);
    setDropping(true);
    try {
      await post(`/movies/${id}/drop-keep`);
      await history.reload();
    } catch (e) {
      setDropError(e instanceof ApiError ? e.message : 'Action failed.');
    } finally {
      setDropping(false);
    }
  }

  async function convert() {
    setConvertError(null);
    setConvertResult(null);
    setConverting(true);
    try {
      const result = await post<ConvertToManagedResult>(`/movies/${id}/convert`);
      setConvertResult(
        result.queued
          ? 'Converted — immediately queued for deletion review (already watched, on a remove-on-watch list).'
          : 'Converted to Filmstrip control.'
      );
      await history.reload();
    } catch (e) {
      setConvertError(e instanceof ApiError ? e.message : 'Action failed.');
    } finally {
      setConverting(false);
    }
  }

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
          <p className="muted" style={{ marginBottom: 8 }}>
            tmdb {history.data.movie.tmdbId} · <StateBadge state={history.data.movie.state} />
          </p>

          <p className="muted" style={{ marginBottom: 16 }}>
            Claimed by:{' '}
            {history.data.claims.length === 0 ? (
              <em>no lists</em>
            ) : (
              history.data.claims.map((c) => (
                <span key={c.listId} className="badge" style={{ marginRight: 4 }}>
                  {c.listLabel}
                </span>
              ))
            )}
          </p>

          {me?.isAdmin && history.data.movie.state === 'kept' && history.data.claims.length === 0 && (
            <div style={{ marginBottom: 16 }}>
              <button disabled={dropping} onClick={dropKeep}>
                Drop keep status
              </button>
              {dropError && <div className="error">{dropError}</div>}
            </div>
          )}

          {me?.isAdmin && history.data.movie.state === 'pre_existing' && (
            <div style={{ marginBottom: 16 }}>
              <button disabled={converting} onClick={convert}>
                Convert to Filmstrip control
              </button>
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Brings a pre-existing (Seerr/manual) film under Filmstrip's management. If it's on a
                remove-on-watch list already watched since that list added it, it's immediately
                queued for deletion review.
              </p>
              {convertError && <div className="error">{convertError}</div>}
              {convertResult && <p className="muted">{convertResult}</p>}
            </div>
          )}

          {history.data.events.length === 0 ? (
            <p className="muted">No history recorded for this film yet.</p>
          ) : (
            <div className="table-wrap">
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
            </div>
          )}
        </>
      )}
    </div>
  );
}
