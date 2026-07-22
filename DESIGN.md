# Filmstrip — Design

A living design doc for where Filmstrip is headed. It captures the data model, the
removal/keeper logic, the per-list behaviors, and the auth approach. It is a spec to build
against, not a contract — refine it as the feature set firms up.

> Status legend: **[M1 ✅]** built · **[planned]** designed, not yet built.

## 1. Vision & scope

Filmstrip pushes Letterboxd lists/watchlists into Radarr, multi-list and multi-user, managed
from one place. It is a **complement to Jellyseerr, not a replacement** — Seerr stays the
on-demand request path; Filmstrip is the "I live in Letterboxd, keep my lists flowing into the
library" path. The two share an identity backbone (Jellyfin accounts) but serve different habits.

Guiding use case: curate films into lists, let them download automatically, and **don't become a
digital hoarder** — films added for a one-off (e.g. a director watch-through) can be cleaned up
later, with a human in the loop so nothing is lost by accident.

## 2. The keystone: provenance

Filmstrip must never touch films it didn't add (Seerr requests, manual Radarr adds). The signal
is captured at add time: Radarr returns *created* vs *already exists*.

- A film transitions to `Movie.state = 'added'` **only** when Filmstrip itself created the movie
  in Radarr (§10 M7).
- If a film pre-existed (Seerr/manual), its state is `'pre_existing'` instead, and it's **never**
  eligible for removal, even while it sits on a Filmstrip list.

This is the load-bearing invariant for everything in §5–§6.

## 3. Data model

`Settings`, `User`, `List`, `SyncRun` exist today **[M1 ✅]**. `Movie` + `ListMovie` **[M2 ✅]**
replace the per-list `SyncedMovie`; `DeletionRequest` is new **[M3 ✅]**. Jellyfin fields are
**[M4 ✅]**. `Movie.state` + `MovieEvent` are new **[M7 ✅]**, replacing `addedByFilmstrip`/`pinned`
as separate columns — see §4. Remaining fields are marked **[planned]**.

```
Settings (singleton id=1)
  radarr connection (url, apiKey) + global defaults + dryRun        [M1 ✅]
  jellyfin connection (url, apiKey)                                  [M4 ✅]

User
  name, tag (Radarr attribution), enabled                           [M1 ✅]
  letterboxdUsername    -- fetch watched + diary                    [M4 ✅, partial: /films/ scrape, not yet the diary RSS]
  jellyfinUserId        -- Jellyfin watched state; auth link is [planned] (M6) [M4 ✅, partial]

List
  userId, url, listType, label, enabled                             [M1 ✅]
  radarr overrides (quality/root/minAvail/monitored/extraTags)      [M1 ✅]
  takeAmount/takeStrategy, checkIntervalMin                         [M1 ✅]
  -- behavior toggles --
  deleteFiles       bool=true    on approved deletion, delete the file (not just unmonitor) [M3 ✅]
  unwatchedOnly     bool=false   skip films the owner has watched   [M4 ✅]
  removeOnWatch     bool=false   queue for deletion when owner watches it [M4 ✅]
  makeCollection    bool=false   maintain a Jellyfin collection of this list [M4 ✅, unverified live]
  collectionNameOverride  string?                                   [M4 ✅]
  permanence        bool=false   on list deletion, pin its films instead of queueing them [✅]

Movie  (normalized; unique tmdbId)                                  [M2 ✅]
  tmdbId, imdbId?, title, year                                      [M2 ✅]
  state   wanted | pre_existing | added | deletion_queued |
          deleted | kept  -- the single source of truth (§4)        [M7 ✅]
  radarrMovieId?                                                    [M2 ✅]
  jellyfinItemId?   -- resolved + cached by the collection sync     [M4 ✅, unverified live]

ListMovie  (List <-> Movie join; replaces SyncedMovie)             [M2 ✅]
  listId, movieId                                                   [M2 ✅]
  presentOnList     bool         -- still scraped from the list?    [M2 ✅]
  status            pending | added | skipped | failed               [M2 ✅]
  excluded          bool=false   -- never add this film from this list (film-level override) [M2 ✅]
  firstSeenAt, lastSeenAt                                            [M2 ✅]
  removedFromListAt?                                                 [M3 ✅]

SyncRun  (one row per sync attempt: status + counts + timing)      [M1 ✅]

DeletionRequest                                                    [M3 ✅]
  movieId                                                            [M3 ✅]
  reason            left_list | watched | list_deleted [✅]
  triggeredByListId?                                                 [M3 ✅]
  status            pending | approved | kept                        [M3 ✅]
  createdAt, resolvedAt?                                              [M3 ✅]
  resolvedBy?       -- operator identity; deferred until auth (M6)  [planned]

MovieEvent  (append-only per-film history log)                     [M7 ✅]
  movieId                                                            [M7 ✅]
  type   seen_on_list | left_list | restored_to_list |
         radarr_add_failed | added_to_radarr | already_in_radarr |
         deletion_queued | deletion_queue_cancelled | deleted |
         kept | backfilled                                          [M7 ✅]
  detail?, listId?                                                   [M7 ✅]
  createdAt                                                          [M7 ✅]
```

Notes:
- **Normalizing into `Movie`** lets a film appear on many lists once, powers GUI views ("on 3
  lists / requested by 2 people / already in library"), and is the anchor for provenance + state.
- **Film-level overrides**: `ListMovie.excluded` (don't add this one from this list) is the only
  remaining one — `excluded` is modeled but not yet read by the sync/reconcile code. The global
  "force keep" need is now `Movie.state = 'kept'` (§4), not a separate boolean.
- `ListMovie.status = 'pending'` is a transient value meaning "row created, Radarr attempt not yet
  resolved" — every attempted movie gets a row (and starts at `Movie.state = 'wanted'`) *before*
  Radarr is called, specifically so a failed attempt is visible and retried instead of vanishing.

## 4. Film lifecycle: `Movie.state` + history **[M7 ✅]**

Every write to `Movie.state` (and the paired `MovieEvent` row explaining why) goes through one
function, `transitionMovie` (`src/movieState.ts`) — never set directly anywhere else. This
replaced two independently-written booleans (`addedByFilmstrip`, `pinned`) that had already caused
two rounds of the exact same bug class this session: derived state disagreeing with itself because
nothing enforced consistency across the fields it was scattered over.

```
wanted           -- seen on an enabled list; not yet confirmed in Radarr (first scrape, or a
                    failed add being retried next sync)
pre_existing     -- Radarr said "already exists" -- never eligible for deletion_queued (§2)
added            -- Filmstrip's own add succeeded; actively managed
deletion_queued  -- left every list it was wanted on (or watched/list-deleted); DeletionRequest
                    open for review. Only reachable from 'added'
deleted          -- an approved DeletionRequest resolved; removed from Radarr/disk
kept             -- resolved via Keep, or a permanence-on list deletion. Terminal: never
                    transitions away on its own -- the one-way "hands off forever" guarantee
```

`kept` is pure Filmstrip bookkeeping — it changes nothing in Radarr or on disk beyond what already
happened at the transition into it. A film reaches it by:
- clicking **Keep** on a pending deletion (§6) — built, or
- deleting a list whose **permanence** is on (its Filmstrip-managed films transition straight to
  `kept` so they survive) — built (`deleteList` in `src/reconcile`). With permanence off, deleting
  a list instead runs its films through the keeper-rule (reason `list_deleted`).

`MovieEvent` also records per-list `seen_on_list`/`left_list`/`restored_to_list` events for
**every** film regardless of state — including `pre_existing` ones, which otherwise have no
history at all (this is what a pre-existing film leaving a list, previously invisible, now looks
like: a real logged event instead of silence). A per-film history page reading this log is
**[planned]**, not yet built — see §10.

## 5. The keeper-rule (single source of truth for removal) **[M3 ✅, extended M4 ✅]**

Reconcile runs **after each list's own sync**: `reconcileList` (left-the-list) and, when
`removeOnWatch` is on, `reconcileWatched` (owner watched it) — both in `src/reconcile/index.ts`. A
full cross-list reconcile pass independent of sync isn't built. A film becomes a **removal
candidate** only when **all** hold:

1. `Movie.state` is `'added'` (excludes `pre_existing`, `wanted`, and anything already
   `deletion_queued`/`deleted`/`kept` — see §4), **and**
2. no remaining `ListMovie` still wants it — i.e. it isn't `presentOnList` on any enabled list
   (skipped for the `removeOnWatch` trigger — being watched is independently sufficient even if
   the film is still on the list; see §6), **and**
3. its Radarr movie carries **no foreign tags** (only Filmstrip/owner tags) — a guard so a film
   later adopted by Seerr/another tool isn't yanked away.

A candidate is not deleted directly — it enters the approval queue (§6).

`reconcileList` also restores `presentOnList` for a film that reappears in a later scrape after
being marked gone — otherwise a single bad scrape (e.g. a bot-check/interstitial page returning
HTTP 200 with only a handful of links) would sink a film out of its list's Jellyfin collection
permanently, with no self-correction. As a second guard against that same failure mode, a scrape
that would drop more than half of a list's currently-tracked films at once (and at least 3) is
treated as a broken scrape rather than a real edit, and skipped for that run.

For every film confirmed present this run (not only ones that just returned — a request left
stranded by a bad scrape from before this existed needs to self-heal too), `reconcileList` also
cancels any pending `left_list` `DeletionRequest`, transitions the film back to `added`, and
re-monitors it in Radarr: being confirmed on a list directly contradicts a `left_list` claim.
Scoped to `left_list` only — `watched`/`list_deleted` claims don't become false just because the
film is on a list (see §6). `evaluateForDeletion` re-checks `Movie.state` inside a transaction
immediately before transitioning to `deletion_queued`, closing a race window (a manual "sync now"
overlapping the scheduler tick could otherwise create two pending requests for the same film).

## 6. Deletion = mark → review → resolve **[M3 ✅]**

Default action is **delete (with file)**, but never without review.

1. **Mark.** Reconcile (or, later, a watch event) turns a candidate into a `pending`
   `DeletionRequest`. On marking, the film is **unmonitored in Radarr but the file is kept** — it
   stops grabbing upgrades, yet remains watchable during the review window.
2. **Review.** The pending queue is the operator surface: `npm run cli deletions` (CLI now, GUI
   later).
3. **Resolve** via `npm run cli approve <id>` / `npm run cli keep <id>`:
   - **Approve** → delete from Radarr; delete the file if the source list's `deleteFiles` is on
     (default). Request → `approved`; `Movie.state` → `deleted`.
   - **Keep** → request → `kept`; `Movie.state` → `kept`. Never resurfaces.

`removeOnWatch` **[M4 ✅]** means **queue on watch**, not delete on watch — ideal for a
watch-through: blast through the list, then triage what earned a permanent spot. Implemented as
`reconcileWatched`, called once per sync per list with `removeOnWatch` on.

*Future option:* per-list **grace period** to auto-approve after N days of inaction. Default manual.

## 7. Watched state (Letterboxd ∪ Jellyfin) **[M4 ✅]**

A film is "watched" by a user if it's in their **Letterboxd** watched (scraped from their
`/films/` page — the diary RSS `letterboxd.com/{user}/rss/` low-latency signal from the original
design is not yet implemented, see §10) **or** played in **Jellyfin** (via `jellyfinUserId`).
`getOwnerWatchedTmdbIds` (`src/watched/index.ts`) unions both, treating either source's absence or
failure as "nothing watched" rather than failing the sync. Feeds:
- `unwatchedOnly` — subtract the owner's watched set at scrape time (filters what's attempted;
  does not by itself mark anything for deletion).
- `removeOnWatch` — a new watch event marks the film (§6). Jellyfin playback is usually the more
  reliable trigger since that's where viewing actually happens.

## 8. Jellyfin integration **[M4 ✅, makeCollection unverified live]**

Needed for two features:
- **Collections (`makeCollection`)** — maintain a Jellyfin collection (BoxSet) named after the
  list (or `collectionNameOverride`); membership = the list's films matched to Jellyfin items by
  tmdb id (`src/collections/index.ts`, backed by `src/api/jellyfin.ts`). **Caveat:** verified
  against a real Jellyfin server via `live-api-test.yml`, but that instance's library was empty —
  wire compatibility is confirmed, real-media collection matching is not yet exercised end-to-end.
- **Watched state** — read per-user playback (§7).

Connection lives on `Settings` (single Radarr, single Jellyfin for now).

## 9. Auth (GUI) **[M6 ✅, Quick Connect planned]**

Authenticate against **Jellyfin accounts**, mirroring Jellyseerr — the audience already has them,
and we need `jellyfinUserId` anyway.

- **Primary: username/password** proxied to Jellyfin `POST /Users/AuthenticateByName` **[M6 ✅]**.
  Fast with a password manager; no Jellyfin passwords stored (`src/api/jellyfin.authenticateByName`).
- **Optional: Quick Connect** — one-time 6-digit code approved from an existing Jellyfin session;
  no credential handling. **[planned]** — not built; username/password is the only method today.
- **Sessions [M6 ✅]:** on login Filmstrip creates a **DB-backed session** (`Session` model; opaque
  token in an httpOnly cookie, 30-day expiry, revocable) and — chosen over a stateless JWT so
  logout/admin can kill a session before it expires. First login **auto-provisions** a Filmstrip
  `User` linked by `jellyfinUserId` (tag derived from the display name).
- **Roles [M6 ✅]:** Jellyfin's `Policy.IsAdministrator` → Filmstrip admin, cached on the session.
  Admins get settings, user management, the deletion queue, and global sync; any authenticated user
  can manage lists and read sync history. Scoping regular users to *only their own* lists is a
  tracked refinement, not yet enforced.
- Identity (Jellyfin) is separate from the **Letterboxd handle**, which each user sets in profile.

The middleware (`src/server/auth.ts`) gates everything under `/api` except `/api/health` and
`POST /api/auth/login`.

## 10. Open questions / later

- Notifications (Discord/ntfy) on adds, sync failures, and **new pending deletions** to review.
- Three-tier config inheritance (List → User → Settings) so a user's lists default to *their*
  quality profile/root, not just a tag.
- RSS-based scraping where Letterboxd offers it (more robust than HTML).
- Per-list grace-period auto-approval (§6).
- **Per-film history page.** `Movie.state` + the append-only `MovieEvent` log (§4, **[M7 ✅]**) are
  built and populated on every sync, but there's no GUI surfacing the log itself yet — the Movies
  page shows a film's *current* state, not its timeline. A dedicated `/movies/:id` page (the app's
  first param-based route) reading `GET /movies/:id/history` would show the chronological table
  this was originally built for. **[planned]**

## 11. Status

The initial build-out (multi-list core → normalized films/provenance → reconcile + deletion
approval → Jellyfin integration → REST API → React GUI + auth → single-container Docker build) is
complete. This doc owns the *what/how*; **[CLAUDE.md](./CLAUDE.md)** tracks current status,
conventions, and the remaining follow-ups.
