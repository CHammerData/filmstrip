import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, ApiError, MovieRow, RadarrStatus } from '../api';
import { useLoad } from '../useLoad';
import { STATE_META, STATE_FILTERS, StateBadge } from '../movieState';
import { useAuth } from '../auth';

const STATUS_META: Record<RadarrStatus, { label: string; color: string }> = {
  downloaded: { label: 'Downloaded', color: 'var(--ok)' },
  wanted: { label: 'Wanted', color: '#d1a54a' },
  unmonitored: { label: 'Unmonitored', color: 'var(--muted)' },
  not_in_radarr: { label: 'Not in Radarr', color: 'var(--danger)' },
  unknown: { label: 'Unknown', color: 'var(--muted)' },
};

const STATUS_FILTERS = ['all', 'downloaded', 'wanted', 'unmonitored', 'not_in_radarr', 'unknown'] as const;

// Sortable columns (feature request) -- clicking a header sorts by it, clicking again reverses.
// radarrStatus/state sort by lifecycle order (STATUS_FILTERS/STATE_FILTERS, minus 'all'), not
// alphabetically, since that's the order that's actually meaningful for either.
type SortColumn = 'title' | 'owner' | 'radarrStatus' | 'state' | 'size';
interface SortState {
  column: SortColumn;
  dir: 'asc' | 'desc';
}

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

/** A clickable column header: shows a ▲/▼ next to the active sort column, toggles direction on a
 *  repeat click, resets to ascending on a new column. */
function Th({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortColumn;
  sort: SortState;
  onSort: (column: SortColumn) => void;
}) {
  const active = sort.column === column;
  return (
    <th
      onClick={() => onSort(column)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title="Click to sort"
    >
      {label} {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
    </th>
  );
}

export default function Movies() {
  const movies = useLoad<MovieRow[]>(() => get('/movies'));
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [state, setState] = useState<(typeof STATE_FILTERS)[number]>('all');
  const [owner, setOwner] = useState('all');
  const [claimingList, setClaimingList] = useState('all');
  const [listType, setListType] = useState('all');
  const [sort, setSort] = useState<SortState>({ column: 'title', dir: 'asc' });
  const { me } = useAuth();
  const isAdmin = Boolean(me?.isAdmin);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function dropKeep(id: number) {
    setActionError(null);
    setBusyId(id);
    try {
      await post(`/movies/${id}/drop-keep`);
      await movies.reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Action failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function convert(id: number) {
    setActionError(null);
    setBusyId(id);
    try {
      await post(`/movies/${id}/convert`);
      await movies.reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Action failed.');
    } finally {
      setBusyId(null);
    }
  }

  function onSort(column: SortColumn) {
    setSort((prev) =>
      prev.column === column ? { column, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { column, dir: 'asc' }
    );
  }

  const owners = useMemo(
    () => [...new Set((movies.data ?? []).flatMap((m) => m.sources.map((s) => s.ownerName)))].sort(),
    [movies.data]
  );
  const claimingLists = useMemo(
    () => [...new Set((movies.data ?? []).flatMap((m) => m.claims.map((c) => c.listLabel)))].sort(),
    [movies.data]
  );
  const listTypes = useMemo(
    () => [...new Set((movies.data ?? []).flatMap((m) => m.sources.map((s) => s.listType)))].sort(),
    [movies.data]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (movies.data ?? []).filter((m) => {
      if (status !== 'all' && m.radarrStatus !== status) return false;
      if (state !== 'all' && m.state !== state) return false;
      if (owner !== 'all' && !m.sources.some((s) => s.ownerName === owner)) return false;
      if (claimingList !== 'all' && !m.claims.some((c) => c.listLabel === claimingList)) return false;
      if (listType !== 'all' && !m.sources.some((s) => s.listType === listType)) return false;
      if (!q) return true;
      return (
        m.title.toLowerCase().includes(q) ||
        m.sources.some((s) => s.listLabel.toLowerCase().includes(q) || s.ownerName.toLowerCase().includes(q))
      );
    });

    const ownersOf = (m: MovieRow) => [...new Set(m.sources.map((s) => s.ownerName))].sort().join(', ');
    const dir = sort.dir === 'asc' ? 1 : -1;
    const comparator: Record<SortColumn, (a: MovieRow, b: MovieRow) => number> = {
      title: (a, b) => a.title.localeCompare(b.title),
      owner: (a, b) => ownersOf(a).localeCompare(ownersOf(b)),
      radarrStatus: (a, b) => STATUS_FILTERS.indexOf(a.radarrStatus) - STATUS_FILTERS.indexOf(b.radarrStatus),
      state: (a, b) => STATE_FILTERS.indexOf(a.state) - STATE_FILTERS.indexOf(b.state),
      size: (a, b) => (a.radarr?.sizeOnDisk ?? 0) - (b.radarr?.sizeOnDisk ?? 0),
    };
    return [...rows].sort((a, b) => dir * comparator[sort.column](a, b));
  }, [movies.data, query, status, state, owner, claimingList, listType, sort]);

  return (
    <div>
      <h1>Movies</h1>
      <p className="muted">
        Every film Filmstrip tracks — the list(s) that added it, the owner(s) behind those lists, its
        current status in Radarr, and its lifecycle state. Only added/deletion_queued/deleted/kept
        films were ever eligible for the deletion workflow — a pre-existing film leaving a list is
        never queued for review. Click a column header to sort by it.
      </p>

      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ flex: 2 }}>
          <span>Search</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Title, list, or owner…"
          />
        </label>
        <label style={{ flex: 'none', width: 180 }}>
          <span>Radarr status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'all' : STATUS_META[s as RadarrStatus].label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 'none', width: 180 }}>
          <span>State</span>
          <select value={state} onChange={(e) => setState(e.target.value as typeof state)}>
            {STATE_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'all' : STATE_META[s].label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 'none', width: 180 }}>
          <span>Owner</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="all">all</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 'none', width: 180 }}>
          <span>Claiming list</span>
          <select value={claimingList} onChange={(e) => setClaimingList(e.target.value)}>
            <option value="all">all</option>
            {claimingLists.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 'none', width: 180 }}>
          <span>List type</span>
          <select value={listType} onChange={(e) => setListType(e.target.value)}>
            <option value="all">all</option>
            {listTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      {movies.loading && <p className="muted">Loading…</p>}
      {movies.error && <div className="error">{movies.error}</div>}
      {actionError && <div className="error">{actionError}</div>}
      {movies.data && filtered.length === 0 && <p className="muted">No matching films.</p>}

      {filtered.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <Th label="Film" column="title" sort={sort} onSort={onSort} />
                <th>Added by lists</th>
                <th>Claimed by</th>
                <Th label="Owner(s)" column="owner" sort={sort} onSort={onSort} />
                <Th label="Radarr status" column="radarrStatus" sort={sort} onSort={onSort} />
                <Th label="State" column="state" sort={sort} onSort={onSort} />
                <Th label="On disk" column="size" sort={sort} onSort={onSort} />
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const owners = [...new Set(m.sources.map((s) => s.ownerName))];
                const canDropKeep = m.state === 'kept' && m.claims.length === 0;
                const canConvert = m.state === 'pre_existing';
                return (
                  <tr key={m.id}>
                    <td>
                      <Link to={`/movies/${m.id}`}>
                        {m.title}
                        {m.year ? ` (${m.year})` : ''}
                      </Link>
                      <div className="muted" style={{ fontSize: 12 }}>
                        tmdb {m.tmdbId}
                      </div>
                    </td>
                    <td style={{ maxWidth: 220 }}>
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
                    <td style={{ maxWidth: 220 }}>
                      {m.claims.length === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {m.claims.map((c) => (
                            <span key={c.listId} className="badge" style={{ fontSize: 11 }}>
                              {c.listLabel}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="muted">{owners.length ? owners.join(', ') : '—'}</td>
                    <td>
                      <StatusBadge status={m.radarrStatus} />
                    </td>
                    <td>
                      <StateBadge state={m.state} />
                    </td>
                    <td className="muted">{m.radarr ? formatSize(m.radarr.sizeOnDisk) : '—'}</td>
                    {isAdmin && (
                      <td>
                        {(canDropKeep || canConvert) && (
                          <div className="actions">
                            {canDropKeep && (
                              <button disabled={busyId === m.id} onClick={() => dropKeep(m.id)}>
                                Drop keep status
                              </button>
                            )}
                            {canConvert && (
                              <button disabled={busyId === m.id} onClick={() => convert(m.id)}>
                                Convert to Filmstrip control
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
