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

- `Movie.addedByFilmstrip = true` **only** when Filmstrip itself created the movie in Radarr.
- If a film pre-existed (Seerr/manual), it's `false` and is **never** eligible for removal, even
  while it sits on a Filmstrip list.

This is the load-bearing invariant for everything in §5–§6.

## 3. Data model

`Settings`, `User`, `List`, `SyncRun` exist today **[M1 ✅]**. `Movie` + `ListMovie` **[M2 ✅]**
replace the per-list `SyncedMovie`; `DeletionRequest` is new **[M3 ✅]**. Jellyfin fields are
**[M4 ✅]**. Remaining fields are marked **[planned]**.

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
  permanence        bool=false   keep films if this list is deleted [planned -- needs list deletion first]

Movie  (normalized; unique tmdbId)                                  [M2 ✅]
  tmdbId, imdbId?, title, year                                      [M2 ✅]
  addedByFilmstrip  bool         -- the provenance flag (§2)        [M2 ✅]
  radarrMovieId?                                                    [M2 ✅]
  pinned            bool=false   -- "hands off forever" (§4)        [M3 ✅]
  jellyfinItemId?   -- resolved + cached by the collection sync     [M4 ✅, unverified live]

ListMovie  (List <-> Movie join; replaces SyncedMovie)             [M2 ✅]
  listId, movieId                                                   [M2 ✅]
  presentOnList     bool         -- still scraped from the list?    [M2 ✅]
  status            added | skipped | failed                        [M2 ✅]
  excluded          bool=false   -- never add this film from this list (film-level override) [M2 ✅]
  firstSeenAt, lastSeenAt                                            [M2 ✅]
  removedFromListAt?                                                 [M3 ✅]

SyncRun  (one row per sync attempt: status + counts + timing)      [M1 ✅]

DeletionRequest                                                    [M3 ✅]
  movieId                                                            [M3 ✅]
  reason            left_list | watched (list_deleted lands once list deletion exists) [M3+M4 ✅]
  triggeredByListId?                                                 [M3 ✅]
  status            pending | approved | kept                        [M3 ✅]
  createdAt, resolvedAt?                                              [M3 ✅]
  resolvedBy?       -- operator identity; deferred until auth (M6)  [planned]
```

Notes:
- **Normalizing into `Movie`** lets a film appear on many lists once, powers GUI views ("on 3
  lists / requested by 2 people / already in library"), and is the anchor for provenance + pinning.
- **Film-level overrides**: `ListMovie.excluded` (don't add this one from this list) and
  `Movie.pinned` (global keep). A per-list "force keep" was considered and dropped — `pinned`
  covers the real need. `excluded` is modeled but not yet read by the sync/reconcile code.

## 4. "Pinned" **[M3 ✅]**

`Movie.pinned` is pure Filmstrip bookkeeping — it changes nothing in Radarr or on disk. It means
the keeper-rule will **never** queue the film for deletion. It is set by:
- clicking **Keep** on a pending deletion (§6) — built, or
- deleting a list whose **permanence** is on (its films get pinned so they survive) — **[planned]**,
  waits on a list-deletion flow that doesn't exist yet.

## 5. The keeper-rule (single source of truth for removal) **[M3 ✅, extended M4 ✅]**

Reconcile runs **after each list's own sync**: `reconcileList` (left-the-list) and, when
`removeOnWatch` is on, `reconcileWatched` (owner watched it) — both in `src/reconcile/index.ts`. A
full cross-list reconcile pass independent of sync isn't built. A film becomes a **removal
candidate** only when **all** hold:

1. `Movie.addedByFilmstrip` is true, **and**
2. no remaining `ListMovie` still wants it — i.e. it isn't `presentOnList` on any enabled list
   (skipped for the `removeOnWatch` trigger — being watched is independently sufficient even if
   the film is still on the list; see §6), **and**
3. `Movie.pinned` is false, **and**
4. its Radarr movie carries **no foreign tags** (only Filmstrip/owner tags) — a guard so a film
   later adopted by Seerr/another tool isn't yanked away.

A candidate is not deleted directly — it enters the approval queue (§6).

## 6. Deletion = mark → review → resolve **[M3 ✅]**

Default action is **delete (with file)**, but never without review.

1. **Mark.** Reconcile (or, later, a watch event) turns a candidate into a `pending`
   `DeletionRequest`. On marking, the film is **unmonitored in Radarr but the file is kept** — it
   stops grabbing upgrades, yet remains watchable during the review window.
2. **Review.** The pending queue is the operator surface: `npm run cli deletions` (CLI now, GUI
   later).
3. **Resolve** via `npm run cli approve <id>` / `npm run cli keep <id>`:
   - **Approve** → delete from Radarr; delete the file if the source list's `deleteFiles` is on
     (default). Request → `approved`.
   - **Keep** → set `Movie.pinned = true`; request → `kept`. Never resurfaces.

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
  tmdb id (`src/collections/index.ts`, backed by `src/api/jellyfin.ts`). **Caveat:** the Jellyfin
  collection endpoints were implemented from API knowledge, not against a live server — mock-tested
  only. Smoke-test against a real Jellyfin instance before relying on it.
- **Watched state** — read per-user playback (§7).

Connection lives on `Settings` (single Radarr, single Jellyfin for now).

## 9. Auth (GUI, [planned])

Authenticate against **Jellyfin accounts**, mirroring Jellyseerr — the audience already has them,
and we need `jellyfinUserId` anyway.

- **Primary: username/password** proxied to Jellyfin `POST /Users/AuthenticateByName`. Fast with a
  password manager; no Jellyfin passwords stored.
- **Optional: Quick Connect** — one-time 6-digit code approved from an existing Jellyfin session;
  no credential handling. Not per-visit.
- **Sessions:** after either method, Filmstrip issues its own long-lived "remember me" session, so
  the in/out experience is independent of the login method.
- **Roles:** Jellyfin's `Policy.IsAdministrator` → Filmstrip admin. Admins see/approve the global
  deletion queue and all lists; regular users manage their own lists.
- Identity (Jellyfin) is separate from the **Letterboxd handle**, which each user sets in profile.

Not required until the GUI (M6). `User.jellyfinUserId` already exists and is used by M4's
watched-state lookups, but purely as a pointer to a Jellyfin user id — no auth flow reads it yet.

## 10. Open questions / later

- Notifications (Discord/ntfy) on adds, sync failures, and **new pending deletions** to review.
- Three-tier config inheritance (List → User → Settings) so a user's lists default to *their*
  quality profile/root, not just a tag.
- RSS-based scraping where Letterboxd offers it (more robust than HTML).
- Per-list grace-period auto-approval (§6).

## 11. Build order

The roadmap — milestones and sequencing — lives in **[PLAN.md](./PLAN.md)** (single source of
truth). This doc owns the *what/how*; PLAN.md owns the *when*.
