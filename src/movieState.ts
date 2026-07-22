import { Prisma } from '@prisma/client';

/** A transaction client (as passed into prisma.$transaction(async (tx) => ...)). */
export type Tx = Prisma.TransactionClient;

/**
 * The single source of truth for a film's lifecycle (DESIGN.md §10). Only transitionMovie may
 * write this field -- never set it directly anywhere else.
 *
 * wanted           -- seen on an enabled list; Filmstrip wants it in Radarr, not yet confirmed
 *                      (first scrape, or a failed add being retried next sync).
 * pre_existing     -- Radarr said "already exists" when Filmstrip tried to add it. Never eligible
 *                      for deletion_queued -- the provenance keystone (DESIGN.md §2).
 * added            -- Filmstrip's own add succeeded; actively managed.
 * deletion_queued  -- left every list it was wanted on (or watched/list-deleted); a DeletionRequest
 *                      is open for review. Only reachable from `added`.
 * deleted          -- an approved DeletionRequest resolved; actually removed from Radarr/disk.
 *                      Reachable again from `wanted` if the film reappears on a list -- Radarr
 *                      genuinely doesn't have it anymore, so it's a real re-add, not a duplicate.
 * kept             -- a DeletionRequest was resolved via Keep, or a permanence-on list deletion
 *                      pinned it. Terminal: never transitions away from `kept` on its own, matching
 *                      today's one-way "hands off forever" pinned semantics.
 */
export type MovieState = 'wanted' | 'pre_existing' | 'added' | 'deletion_queued' | 'deleted' | 'kept';

/**
 * Append-only history event types (MovieEvent.type). Some accompany a state transition; others
 * (seen_on_list/left_list/restored_to_list) are logged for every film regardless of state -- this
 * is what gives a pre_existing film a real timeline instead of silence.
 */
export type MovieEventType =
  | 'seen_on_list'
  | 'left_list'
  | 'restored_to_list'
  | 'radarr_add_failed'
  | 'added_to_radarr'
  | 'already_in_radarr'
  | 'deletion_queued'
  | 'deletion_queue_cancelled'
  | 'deleted'
  | 'kept'
  | 'revived'
  | 'backfilled';

export interface MovieEventInput {
  type: MovieEventType;
  detail?: string;
  listId?: number;
}

/** Move a film to a new lifecycle state and record why, in one transaction. */
export async function transitionMovie(
  tx: Tx,
  movieId: number,
  toState: MovieState,
  event: MovieEventInput
): Promise<void> {
  await tx.movie.update({ where: { id: movieId }, data: { state: toState } });
  await tx.movieEvent.create({ data: { movieId, ...event } });
}

/** Log a history event that doesn't change the film's overall state (e.g. a pre_existing film
 *  leaving or rejoining a list). */
export async function logMovieEvent(tx: Tx, movieId: number, event: MovieEventInput): Promise<void> {
  await tx.movieEvent.create({ data: { movieId, ...event } });
}
