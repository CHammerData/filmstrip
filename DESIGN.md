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
  -- behavior toggles -- deleting the file on approval is now standard behavior, no longer a
  -- per-list toggle (§6). permanence is mutually exclusive with unwatchedOnly/removeOnWatch
  -- (enforced in src/server/routes/lists.ts + the GUI) -- a list that's meant to keep everything
  -- it claims forever can't also be conditioned on watch-state.
  unwatchedOnly     bool=false   skip films the owner has watched   [M4 ✅]
  removeOnWatch     bool=false   queue for deletion review on a real diary watch date postdating
                                 this list's own claim, unless another ordinary claim remains (§7) [M4 ✅]
  makeCollection    bool=false   maintain a Jellyfin collection of this list [M4 ✅, unverified live]
  collectionNameOverride  string?                                   [M4 ✅]
  permanence        bool=false   any film this list currently claims is pinned to `kept`
                                 immediately, live -- not just when the list is deleted (§4-§5) [✅]

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
  reason  left_list | watched | list_deleted | list_deactivated | manual_reopen [✅]
  triggeredByListId?                                                 [M3 ✅]
  status            pending | approved | kept                        [M3 ✅]
  createdAt, resolvedAt?                                              [M3 ✅]
  resolvedBy?       -- operator identity; deferred until auth (M6)  [planned]

MovieEvent  (append-only per-film history log)                     [M7 ✅]
  movieId                                                            [M7 ✅]
  type   seen_on_list | left_list | list_deleted | list_deactivated |
         watch_dropped | restored_to_list | radarr_add_failed |
         added_to_radarr | already_in_radarr | deletion_queued |
         deletion_queue_cancelled | deleted | kept | revived | backfilled [✅]
  detail?, listId?                                                   [M7 ✅]
  createdAt                                                          [M7 ✅]
```

Notes:
- **Normalizing into `Movie`** lets a film appear on many lists once, powers GUI views ("on 3
  lists / requested by 2 people / already in library"), and is the anchor for provenance + state.
- **Claim** (§5): a list *claims* a film when its `ListMovie` row has `presentOnList: true` and
  `excluded: false`, and the list itself is `enabled`. This is the one shared predicate behind the
  keeper-rule's "still wanted" check, permanence, and the GUI's "claimed by" display — computed live
  (`hasClaim`/`hasOrdinaryClaim` in `src/reconcile/index.ts`), not a separate stored concept.
  `ListMovie.excluded` (don't add this one from this list) is the one remaining film-level override,
  now wired into every claim check. The global "force keep" need is `Movie.state = 'kept'` (§4), not
  a separate boolean.
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
deletion_queued  -- zero remaining claims (every list it was wanted on left, was deleted, or was
                    disabled), or watched with removeOnWatch; DeletionRequest open for review.
                    Only reachable from 'added' (or, via manual_reopen, from 'kept' -- §6)
deleted          -- an approved DeletionRequest resolved; removed from Radarr/disk. Revived to
                    'wanted' if the film reappears on a list -- a genuine re-add, not a duplicate,
                    since Radarr no longer has it
kept             -- resolved via Keep, a permanence claim (live or at list-deletion), or was there
                    already when a new permanence claim was confirmed. Terminal on its own -- never
                    transitions away except via the manual `manual_reopen` override (§6)
```

`kept` is pure Filmstrip bookkeeping — it changes nothing in Radarr or on disk beyond what already
happened at the transition into it. A film reaches it by:
- clicking **Keep** on a pending deletion (§6) — built, or
- being claimed by an enabled **permanence** list — live, the instant the claim exists (first sync,
  or the film reappearing on the list), not just when the list is later deleted (§5) — built, or
- deleting a list whose **permanence** is on (its Filmstrip-managed films transition straight to
  `kept` so they survive) — built (`deleteList` in `src/reconcile`). With permanence off, deleting
  a list instead runs its films through the keeper-rule (reason `list_deleted`).

`kept` and `deleted` are not symmetric on purpose: `kept` means "never manage this film again,
regardless of what happens to it later" (matches the old one-way `pinned` semantics exactly), while
`deleted` just means "not currently in Radarr" — the moment the owner re-adds it to a list, that's
a fresh, legitimate want, so `reconcileList` revives it to `wanted` instead of leaving it stranded.
The one deliberate crack in `kept`'s terminality is `dropKeepStatus` (§6) — a human-triggered
override, never something the keeper-rule does on its own.

`MovieEvent` also records **every individual claim gained or dropped**, for **every** film
regardless of state — including `pre_existing` ones, which otherwise have no history at all. A
list's claim can end four ways, each its own event type: `left_list` (scraped off the list),
`list_deleted` (the list itself was deleted), `list_deactivated` (the list was disabled), and
`watch_dropped` (a `removeOnWatch` list drops it once the owner's diary shows it watched) — logged
*regardless* of whether that particular claim-drop happens to be the one that zeroes the film out
(DESIGN.md §5). This is what makes the worked example in the film's history read as a real audit
trail: *List A claims F → List B claims F → List A deleted (claim dropped, list_deleted) → List C
claims F → List B disabled (claim dropped, list_deactivated) → F watched, List C drops it
(watch_dropped) → zero claims remain → queued for deletion*. A per-film history page (`GET
/movies/:id/history`; `/movies/:id` in the GUI, reached by clicking a film on the Movies page)
shows this log as a chronological table, plus the film's **current** claiming lists and (when the
film is `kept` with zero claims) a **Drop keep status** button (§6).

## 5. The keeper-rule (single source of truth for removal) **[M3 ✅, extended M4 ✅]**

A list **claims** a film when its `ListMovie` row has `presentOnList: true` and `excluded: false`,
and the list itself is `enabled` (`hasClaim` in `src/reconcile/index.ts`) — the single predicate
behind everything below. An **ordinary claim** (`hasOrdinaryClaim`) additionally requires the list
not have `removeOnWatch` on — used only by the `watched` reason, where a list that itself wants a
film gone on watch shouldn't count as "someone still wants this."

Reconcile runs **after each list's own sync**: `reconcileList` (left-the-list), `reconcileWatched`
(owner watched it, when `removeOnWatch` is on), and `applyPermanenceClaims` (live permanence, when
`permanence` is on) — all in `src/reconcile/index.ts`, called from `syncList` in that order (order
matters — see below). A full cross-list reconcile pass independent of sync isn't built, except for
one trigger that runs outside any sync: disabling a list (`handleListDisabled`, called from the
`PATCH /lists/:id` route the instant `enabled` flips false→true, since a disabled list is otherwise
never synced again and its claims would just sit stale forever). A film becomes a **removal
candidate** only when **all** hold:

1. `Movie.state` is `'added'` (excludes `pre_existing`, `wanted`, and anything already
   `deletion_queued`/`deleted`/`kept` — see §4), **and**
2. it has no remaining claim (skipped for the `removeOnWatch` trigger — being watched is
   independently sufficient even if the film is still on the list; see §6-§7), **and**
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
runs `cancelStaleDeletionRequests`: any pending `left_list`/`list_deleted`/`list_deactivated`/
`manual_reopen` request is cancelled by **any** remaining claim, while a pending `watched` request
is cancelled only by an **ordinary** claim (a non-`removeOnWatch` list) — matching the state
diagram's `deletion_queued -> added` edge. Cancelling transitions the film back to `added` and
re-monitors it in Radarr. `evaluateForDeletion` re-checks `Movie.state` inside a transaction
immediately before transitioning to `deletion_queued`, closing a race window (a manual "sync now"
overlapping the scheduler tick could otherwise create two pending requests for the same film).

**Live permanence.** `applyPermanenceClaims(list)` runs every sync of a `permanence` list: any film
it currently claims that's still `added` or `deletion_queued` is pinned straight to `kept` — coming
from `deletion_queued`, this also auto-resolves the pending `DeletionRequest` to `kept` (matching
the diagram's `deletion_queued -> kept` edge on a new permanence claim), without waiting for human
review. This is what makes permanence a *live, continuous* guarantee rather than a one-time action
at list-deletion (§6) — it also self-heals films that were `added`/`deletion_queued` from before
this feature existed, or before permanence was toggled on for that list. It must run *after*
`reconcileList`/`reconcileWatched` in the same sync — otherwise a film this list is claiming could
be queued by `reconcileWatched` moments earlier in the same tick and sit wrong for a full extra
sync interval before the next permanence pass caught it.

## 6. Deletion = mark → review → resolve **[M3 ✅]**

Default action is **delete (with file)** — deleting the file is now standard behavior, not a
per-list toggle — but never without review.

1. **Mark.** Reconcile turns a candidate into a `pending` `DeletionRequest`. On marking, the film is
   **unmonitored in Radarr but the file is kept** — it stops grabbing upgrades, yet remains
   watchable during the review window.
2. **Review.** The pending queue is the operator surface: `npm run cli deletions` / the Deletions
   page in the GUI. The Movies page and a film's history page also show its **current claiming
   lists** live (DESIGN.md §5).
3. **Resolve** via `npm run cli approve <id>` / `npm run cli keep <id>` (or the equivalent GUI
   buttons):
   - **Approve** → delete from Radarr and its file. Request → `approved`; `Movie.state` →
     `deleted`.
   - **Keep** → request → `kept`; `Movie.state` → `kept`. Never resurfaces on its own.

**Manual reopen.** `dropKeepStatus` (`POST /movies/:id/drop-keep`, admin-only) is the one deliberate
crack in `kept`'s terminality: releases a `kept` film with **zero current claims** back into
`deletion_queued` (reason `manual_reopen`), for when an old Keep or a permanence claim no longer
reflects anyone's intent. The GUI only shows the button under that same condition (`state === 'kept'
&& claims.length === 0`), but the server re-checks it independently — throws if the film isn't
`kept`, or if any enabled list still claims it.

`removeOnWatch` **[M4 ✅]** means **queue on watch**, not delete on watch — ideal for a
watch-through: blast through the list, then triage what earned a permanent spot. Implemented as
`reconcileWatched`, called once per sync per list with `removeOnWatch` on (§7).

`permanence` cannot be combined with `unwatchedOnly`/`removeOnWatch` on the same list (enforced
server-side in `src/server/routes/lists.ts` and client-side by disabling the conflicting toggles in
the GUI) — a list that's meant to keep everything it claims forever can't also be conditioned on
watch-state.

*Future option:* per-list **grace period** to auto-approve after N days of inaction. Default manual.

## 7. Watched state (Letterboxd ∪ Jellyfin) **[M4 ✅]**

A film is "watched" by a user if it's in their **Letterboxd** watched (scraped from their
`/films/` page, or diary-logged — `src/scraper/diary.ts`) **or** played in **Jellyfin** (via
`jellyfinUserId`). Both feed the `WatchedFilm` cache (`userId, tmdbId, watchedAt?, source`),
refreshed independently of any list's own sync on `Settings.watchedRefreshIntervalMin`
(`refreshWatchedState`/`refreshDueUsers` in `src/watched/index.ts`) — decoupled so it runs once per
user regardless of how many lists they own. Only `letterboxd_diary` rows ever carry a real
`watchedAt`; `letterboxd_aggregate` (the `/films/` page) and `jellyfin` rows are presence-only,
since neither can distinguish "just watched" from "watched years ago."
- `unwatchedOnly` — subtract the owner's watched set at scrape time (filters what's attempted; does
  not by itself mark anything for deletion). Still reads the live per-call
  `getOwnerWatchedTmdbIds` union (presence-only, no dates needed).
- `removeOnWatch` — reads the diary-date cache instead (`getDiaryWatchedDates`), since it needs a
  real date. For each film a `removeOnWatch` list currently claims, it queues the film (and logs a
  `watch_dropped` claim-drop event, §4) only if: the diary date is real *and* postdates this list's
  own `ListMovie.firstSeenAt` for the film (so a stale pre-list watch, or a presence-only
  aggregate/Jellyfin watch, never triggers it), *and* no other enabled, non-`removeOnWatch` list
  still ordinarily claims the film (that list's plain claim takes precedence — the film isn't
  queued until every interested party agrees it should go on watch).

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

## 11. Status

The initial build-out (multi-list core → normalized films/provenance → reconcile + deletion
approval → Jellyfin integration → REST API → React GUI + auth → single-container Docker build) is
complete. This doc owns the *what/how*; **[CLAUDE.md](./CLAUDE.md)** tracks current status,
conventions, and the remaining follow-ups.
