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

`Settings`, `User`, `List`, `SyncRun` exist today **[M1 ✅]**. `Movie` + `ListMovie` replace the
per-list `SyncedMovie`; `DeletionRequest` is new. New fields are marked **[planned]**.

```
Settings (singleton id=1)
  radarr connection (url, apiKey) + global defaults + dryRun        [M1 ✅]
  jellyfin connection (url, apiKey)                                  [planned]

User
  name, tag (Radarr attribution), enabled                           [M1 ✅]
  letterboxdUsername    -- fetch watched + diary                    [planned]
  jellyfinUserId        -- auth link + Jellyfin watched/collections [planned]

List
  userId, url, listType, label, enabled                             [M1 ✅]
  radarr overrides (quality/root/minAvail/monitored/extraTags)      [M1 ✅]
  takeAmount/takeStrategy, checkIntervalMin                         [M1 ✅]
  -- behavior toggles --                                            [planned]
  permanence        bool=false   keep films if this list is deleted
  unwatchedOnly     bool=false   skip films the owner has watched
  removeOnWatch     bool=false   queue for deletion when owner watches it
  deleteFiles       bool=true    on approved deletion, delete the file (not just unmonitor)
  makeCollection    bool=false   maintain a Jellyfin collection of this list
  collectionNameOverride  string?

Movie  (normalized; unique tmdbId)                                  [planned]
  tmdbId, imdbId?, title, year
  addedByFilmstrip  bool         -- the provenance flag (§2)
  radarrMovieId?, jellyfinItemId?
  pinned            bool=false   -- "hands off forever" (§4)

ListMovie  (List <-> Movie join; replaces SyncedMovie)             [planned]
  listId, movieId
  presentOnList     bool         -- still scraped from the list?
  firstSeenAt, lastSeenAt, removedFromListAt?
  status            added | skipped | failed
  excluded          bool=false   -- never add this film from this list (film-level override)

SyncRun  (one row per sync attempt: status + counts + timing)      [M1 ✅]

DeletionRequest                                                    [planned]
  movieId
  reason            list_deleted | left_list | watched
  triggeredByListId?
  status            pending | approved | kept
  createdAt, resolvedAt?, resolvedBy?
```

Notes:
- **Normalizing into `Movie`** lets a film appear on many lists once, powers GUI views ("on 3
  lists / requested by 2 people / already in library"), and is the anchor for provenance + pinning.
- **Film-level overrides**: `ListMovie.excluded` (don't add this one from this list) and
  `Movie.pinned` (global keep). A per-list "force keep" was considered and dropped — `pinned`
  covers the real need.

## 4. "Pinned"

`Movie.pinned` is pure Filmstrip bookkeeping — it changes nothing in Radarr or on disk. It means
the keeper-rule will **never** queue the film for deletion. It is set by:
- clicking **Keep** on a pending deletion (§6), or
- deleting a list whose **permanence** is on (its films get pinned so they survive).

## 5. The keeper-rule (single source of truth for removal)

Reconcile runs after syncs and on relevant events. A film becomes a **removal candidate** only
when **all** hold:

1. `Movie.addedByFilmstrip` is true, **and**
2. no remaining `ListMovie` still wants it — i.e. it isn't `presentOnList` on any enabled list, **and**
3. `Movie.pinned` is false, **and**
4. its Radarr movie carries **no foreign tags** (only Filmstrip/owner tags) — a guard so a film
   later adopted by Seerr/another tool isn't yanked away.

A candidate is not deleted directly — it enters the approval queue (§6).

## 6. Deletion = mark → review → resolve

Default action is **delete (with file)**, but never without review.

1. **Mark.** Reconcile (or a watch event) turns a candidate into a `pending` `DeletionRequest`.
   On marking, the film is **unmonitored in Radarr but the file is kept** — it stops grabbing
   upgrades, yet remains watchable during the review window.
2. **Review.** The pending queue is the operator surface (CLI now, GUI later).
3. **Resolve:**
   - **Approve** → delete from Radarr; delete the file if the source list's `deleteFiles` is on
     (default). Request → `approved`.
   - **Keep** → set `Movie.pinned = true`; request → `kept`. Never resurfaces.

`removeOnWatch` therefore means **queue on watch**, not delete on watch — ideal for a
watch-through: blast through the list, then triage what earned a permanent spot.

*Future option:* per-list **grace period** to auto-approve after N days of inaction. Default manual.

## 7. Watched state (Letterboxd ∪ Jellyfin)

A film is "watched" by a user if it's in their **Letterboxd** diary/watched (scraped from their
`/films/`, with the diary RSS `letterboxd.com/{user}/rss/` as the low-latency signal) **or**
played in **Jellyfin** (via `jellyfinUserId`). Feeds:
- `unwatchedOnly` — subtract the owner's watched set at scrape time.
- `removeOnWatch` — a new watch event marks the film (§6). Jellyfin playback is usually the more
  reliable trigger since that's where viewing actually happens.

## 8. Jellyfin integration

Needed for two features:
- **Collections (`makeCollection`)** — maintain a Jellyfin collection (BoxSet) named after the
  list (or `collectionNameOverride`); membership = the list's films matched to Jellyfin items by
  tmdb/imdb id.
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

Not required for M2/CLI — only the model fields are added now.

## 10. Open questions / later

- Notifications (Discord/ntfy) on adds, sync failures, and **new pending deletions** to review.
- Three-tier config inheritance (List → User → Settings) so a user's lists default to *their*
  quality profile/root, not just a tag.
- RSS-based scraping where Letterboxd offers it (more robust than HTML).
- Per-list grace-period auto-approval (§6).

## 11. Build order

The roadmap — milestones and sequencing — lives in **[PLAN.md](./PLAN.md)** (single source of
truth). This doc owns the *what/how*; PLAN.md owns the *when*.
