import { useMemo, useState } from 'react';
import { get, MovieRow, RadarrStatus } from '../api';
import { useLoad } from '../useLoad';

const STATUS_META: Record<RadarrStatus, { label: string; color: string }> = {
  downloaded: { label: 'Downloaded', color: 'var(--ok)' },
  wanted: { label: 'Wanted', color: '#d1a54a' },
  unmonitored: { label: 'Unmonitored', color: 'var(--muted)' },
  not_in_radarr: { label: 'Not in Radarr', color: 'var(--danger)' },
  unknown: { label: 'Unknown', color: 'var(--muted)' },
};

const STATUS_FILTERS = ['all', 'downloaded', 'wanted', 'unmonitored', 'not_in_radarr', 'unknown'] as const;

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function StatusBadge({ status }: { status: RadarrStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="badge"
      style={{ background: 'transparent', border: `1px solid ${meta.color}`, color: meta.color }}
    >
      {meta.label}
    </span>
  );
}

export default function Movies() {
  const movies = useLoad<MovieRow[]>(() => get('/movies'));
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (movies.data ?? []).filter((m) => {
      if (status !== 'all' && m.radarrStatus !== status) return false;
      if (!q) return true;
      return (
        m.title.toLowerCase().includes(q) ||
        m.sources.some((s) => s.listLabel.toLowerCase().includes(q) || s.ownerName.toLowerCase().includes(q))
      );
    });
  }, [movies.data, query, status]);

  return (
    <div>
      <h1>Movies</h1>
      <p className="muted">
        Every film Filmstrip tracks — the list(s) that added it, the owner(s) behind those lists, and
        its current status in Radarr.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <label style={{ flex: 2 }}>
          <span>Search</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Title, list, or owner…"
          />
        </label>
        <label style={{ flex: 'none', width: 200 }}>
          <span>Radarr status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'all' : STATUS_META[s as RadarrStatus].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {movies.loading && <p className="muted">Loading…</p>}
      {movies.error && <div className="error">{movies.error}</div>}
      {movies.data && filtered.length === 0 && <p className="muted">No matching films.</p>}

      {filtered.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Film</th>
              <th>Added by lists</th>
              <th>Owner(s)</th>
              <th>Radarr status</th>
              <th>On disk</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const owners = [...new Set(m.sources.map((s) => s.ownerName))];
              return (
                <tr key={m.id}>
                  <td>
                    {m.title}
                    {m.year ? ` (${m.year})` : ''}
                    <div className="muted" style={{ fontSize: 12 }}>
                      tmdb {m.tmdbId}
                      {m.pinned ? ' · pinned' : ''}
                    </div>
                  </td>
                  <td>
                    {m.sources.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {m.sources.map((s) => (
                          <span
                            key={s.listId}
                            className="badge"
                            style={{ fontSize: 11 }}
                            title={s.listType}
                          >
                            {s.listLabel}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="muted">{owners.length ? owners.join(', ') : '—'}</td>
                  <td>
                    <StatusBadge status={m.radarrStatus} />
                  </td>
                  <td className="muted">{m.radarr ? formatSize(m.radarr.sizeOnDisk) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
