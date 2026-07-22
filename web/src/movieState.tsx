import { MovieState } from './api';

// A film's lifecycle state (DESIGN.md §4) -- the single source of truth for what Filmstrip is
// doing (or will never do) with it. pre_existing/wanted are never eligible for the deletion
// workflow; the rest describe where it sits in that workflow. Shared between the Movies list and
// the per-film history page so both always agree on labels/colors.
export const STATE_META: Record<MovieState, { label: string; color: string }> = {
  wanted: { label: 'Wanted', color: '#d1a54a' },
  pre_existing: { label: 'Pre-existing', color: 'var(--muted)' },
  added: { label: 'Added by Filmstrip', color: 'var(--ok)' },
  deletion_queued: { label: 'Queued for deletion', color: 'var(--danger)' },
  deleted: { label: 'Deleted', color: 'var(--muted)' },
  kept: { label: 'Kept', color: 'var(--ok)' },
};

export const STATE_FILTERS = ['all', 'wanted', 'pre_existing', 'added', 'deletion_queued', 'deleted', 'kept'] as const;

export function StateBadge({ state }: { state: MovieState }) {
  const meta = STATE_META[state];
  return (
    <span
      className="badge"
      style={{ background: 'transparent', border: `1px solid ${meta.color}`, color: meta.color }}
      title="This film's lifecycle state -- only added/deletion_queued/deleted/kept were ever eligible for Filmstrip's deletion workflow; pre_existing and wanted never are (DESIGN.md §2, §4)."
    >
      {meta.label}
    </span>
  );
}
