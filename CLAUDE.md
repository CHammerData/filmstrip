# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**Filmstrip** syncs Letterboxd watchlists/lists into Radarr. It is a fork of
[ryanpag3/lettarrboxd](https://github.com/ryanpag3/lettarrboxd) (a single-list, env-configured
daemon) rebuilt into a **multi-list, multi-user, DB-backed service** with a CLI, a REST API, and a
React GUI. See [DESIGN.md](./DESIGN.md) for the data model + feature design (provenance, the
keeper-rule, deletion approval, Jellyfin auth); this file is the working reference for the code
layout, conventions, and current status.

## Key decisions

| Area | Choice | Why |
| :--- | :--- | :--- |
| Base | True fork of upstream | Keep attribution + cherry-pick upstream scraper/Radarr fixes |
| Backend | TypeScript/Node → Express API + scheduler | Reuse the working `src/scraper` + `src/api/radarr` modules |
| Frontend | React + Vite SPA | Clean split from the API |
| Persistence | SQLite + Prisma (v6) | Typed schema + migrations; single-file DB fits one container |
| Packaging | One container: Express serves the SPA **and** `/api` | Collapses the upstream "N containers for N lists" model |
| Provenance | Only ever touch films Filmstrip added (`Movie.state`) | Never clobber Seerr/manual adds — see [DESIGN.md §2](./DESIGN.md) |
| Removal | Delete-by-default, behind a human **approval queue** | Avoid hoarding without risking accidental loss — [DESIGN.md §6](./DESIGN.md) |
| Identity/auth | Jellyfin accounts (username/password today; Quick Connect planned) | Audience already has them; complements Seerr — [DESIGN.md §9](./DESIGN.md) |

## Commands

- `npm install` — install deps (this fork uses **npm** + `package-lock.json`; upstream's `yarn.lock`
  was removed — do not run `yarn`, it would resurrect a competing lockfile)
- `npx prisma migrate dev` — create/apply migrations + generate the Prisma client (run after clone)
- `npm run seed` — bootstrap Settings/User/List from env vars (see `.env.example`)
- `npm run cli <sync-all | sync-due | sync <listId> | lists | deletions | approve <id> | keep <id>>`
  — drive syncs and the deletion-review queue manually
- `npm run start:dev` — boot the scheduler (1-min tick, honors per-list intervals) **and** the REST
  API (Express, routes under `/api`, `PORT` env, default 3000). If `web/dist` exists it also serves
  the SPA.
- **Web GUI** lives in **`web/`** as a separate npm package (React + Vite). `cd web && npm run dev`
  runs Vite on :5173 with an `/api` proxy to :3000 (dev); `npm run build` emits `web/dist`, which
  the Express server serves in production. `web/` has its own `package.json`/`node_modules`.
- `npm run test:unit` — unit tests (no network); `npm run test:integration` hits live Letterboxd;
  `npm run test:live` exercises `src/api/radarr.ts`/`src/api/jellyfin.ts` against real Radarr/
  Jellyfin instances — skips cleanly if `RADARR_TEST_URL`/`JELLYFIN_TEST_URL` etc. aren't set (see
  `.github/workflows/live-api-test.yml`, which boots + configures both via Docker for CI)
- `npx tsc --noEmit` — typecheck

## Architecture

Config lives in **SQLite via Prisma**, not env vars. The data model is in
[prisma/schema.prisma](./prisma/schema.prisma): `Settings` (singleton: Radarr + Jellyfin
connections, global defaults, `watchedRefreshIntervalMin`), `User` (owns lists; carries a Radarr
attribution tag, plus `letterboxdUsername`/`jellyfinUserId` for watched-state and
`lastWatchedRefreshAt`), `List` (a Letterboxd URL with per-list overrides that fall back to
Settings, plus `unwatchedOnly`/`removeOnWatch`/`makeCollection`/`collectionNameOverride` and
`permanence` — a **live** guarantee, DESIGN.md §4-§6, mutually exclusive with
`unwatchedOnly`/`removeOnWatch`; deleting a file on approval is now always-on, no longer a per-list
toggle), `SyncRun` (one row per sync attempt), `Movie` (a film normalized across lists by `tmdbId`,
carrying `state` — the single source of truth for its lifecycle, DESIGN.md §4 — and
`jellyfinItemId`), `ListMovie` (the `List`<->`Movie` join — membership, presence, per-list
`excluded` — replaces the old per-list `SyncedMovie`/`movies.json`; a list **claims** a film when
`presentOnList && !excluded` and the list is `enabled`, DESIGN.md §5), `WatchedFilm` (one user's
per-film watched cache — `watchedAt`/`source`, only `letterboxd_diary` rows carry a real date,
DESIGN.md §7), `DeletionRequest` (the approval-queue row a removal candidate sits in until approved
or kept; `reason` ∈ `left_list | watched | list_deleted | list_deactivated | manual_reopen`),
`MovieEvent` (append-only per-film history log, DESIGN.md §4 — every claim gained/dropped is
logged, with why).

Module layout:
- **`src/scraper/`** — reused from upstream. `fetchMoviesFromUrl(url, take?, strategy?, http?)`
  detects the list type and delegates to a per-type scraper. Stateless; takes params, reads no
  globals. `http.ts` holds the fetch ladder (see "Letterboxd blocks" below) and is the one piece of
  module state in here — a learned per-host "Node's fetch is blocked" cache, not config.
- **`src/api/flaresolverr.ts`** — `fetchViaFlaresolverr({url}, targetUrl)` posts a `request.get` to
  FlareSolverr's `/v1` and returns the solved page as a `Response`, so it drops into the same ladder
  as `fetch`/curl. Optional: unset `Settings.flaresolverrUrl` just means no browser rung.
- **`src/films/cache.ts`** — `createFilmCache()`: the prisma-backed `FilmCache` the scraper takes as
  an injected interface (`LetterboxdFilm`, slug → tmdbId, permanent — a slug always names the same
  film). Lives outside `src/scraper` so the scraper stays DB-free. Without it a single watched-state
  refresh cost ~3,500 film-page fetches and every list sync re-resolved every film on the list.
- **`src/api/radarr.ts`** — reused/parameterized. `createRadarrClient({url, apiKey})` builds an axios
  client; `upsertMovies(client, movies, options)` adds movies and returns an `UpsertSummary` of
  per-movie outcomes; `getMovieById`/`getAllTags`/`setMonitored`/`deleteMovie(client, id)` (always
  deletes the file — no longer a caller-supplied flag) back the reconcile flow. No global/env reads.
- **`src/api/jellyfin.ts`** — `createJellyfinClient({url, apiKey})`; `getWatchedTmdbIds` (per-user
  played movies), `getAllMovieProviderIds` (library-wide tmdbId→item-id map), and the BoxSet helpers:
  `findCollectionByName` (name search, only used to adopt a pre-existing/hand-created collection),
  `getCollectionById` (identity lookup, null on a 404 or any other fetch failure),
  `createCollection`, `renameCollection` (GETs current metadata, POSTs it back with only `Name`
  changed -- Jellyfin's update endpoint replaces the full payload), `deleteCollection`,
  `getCollectionItemIds`/`addToCollection`/`removeFromCollection`. Verified against a real
  `lscr.io/linuxserver/jellyfin` instance (`src/api/jellyfin.livetest.ts` + `live-api-test.yml`) —
  the library was empty (no media files) in that run, so wire compatibility (paths/params/auth/
  response shape) is confirmed but real-media collection matching is not exercised end-to-end.
- **`src/db/`** — `client.ts` (PrismaClient singleton) and `config.ts`
  (`resolveListConfig(list, settings)`: merges overrides over defaults, assembles tags as
  `[userTag, "letterboxd", ...extraTags]`, throws on missing Radarr connection / quality profile;
  also exports `parseExtraTags`/`GLOBAL_TAG`, reused by reconcile's foreign-tag check).
- **`src/watched/index.ts`** — `getOwnerWatchedTmdbIds(user, settings)` (**@deprecated**, still used
  by `unwatchedOnly`): unions a user's live Letterboxd `/films/` scrape and Jellyfin watched set,
  presence-only. `refreshWatchedState(user, settings)` upserts the `WatchedFilm` cache from three
  sources (diary — `src/scraper/diary.ts`, dated; aggregate `/films/`; Jellyfin), diary always
  winning on a real date; `refreshDueUsers`/`startWatchedStateScheduler` run it per-user on
  `Settings.watchedRefreshIntervalMin`, independent of any list's sync (wired into `src/index.ts`
  alongside `startScheduler`). The diary and aggregate fetches run one after another, not
  concurrently — confirmed live that firing both at once against the same account's own profile
  pages (`/diary/` and `/films/`) got both 403'd within ~350ms of each other, while either run in
  isolation succeeds reliably; Jellyfin is a different host, so it still runs concurrently with
  them. `getDiaryWatchedDates(userId)` reads the cache back as a `tmdbId -> watchedAt` map
  (`letterboxd_diary` rows only) — what `removeOnWatch` reads (DESIGN.md §7). Any source
  missing/failing degrades to empty, never throws.
- **`src/collections/index.ts`** — `syncCollection(list, collectionName)`: resolves each of the
  list's current films to a Jellyfin item id (cached on `Movie.jellyfinItemId` after the first
  lookup), then creates or diffs membership of the BoxSet. Tracks the collection by
  `List.jellyfinCollectionId` (identity), not by re-searching for `collectionName` every run --
  editing a list's label/collectionNameOverride used to stop matching the old collection by name and
  create a duplicate, stranding the original in Jellyfin. A stored id that no longer resolves (404 --
  deleted directly in Jellyfin) falls back to a one-time `findCollectionByName` to adopt a
  pre-existing/hand-created collection instead of duplicating it; once adopted, a name mismatch is
  applied as a rename via `renameCollection`, not treated as a miss. `reconcile.deleteList` deletes
  the mirrored collection (`deleteCollection`) when the deleted list had `makeCollection` on and an
  id on record.
- **`src/movieState.ts`** — the single place allowed to write `Movie.state` (DESIGN.md §4).
  `transitionMovie(tx, movieId, toState, event)` updates `Movie.state` and appends a `MovieEvent`
  in one call; `logMovieEvent(tx, movieId, event)` appends a history event without changing state
  (used for per-list `seen_on_list`/`left_list`/`restored_to_list`, which apply to every film
  regardless of state). Both take a transaction client so callers control atomicity.
- **`src/scheduler/index.ts`** — `syncList` (scrape → optionally filter by watched state
  (`unwatchedOnly`) → dedup vs `ListMovie` by `tmdbId`, retrying anything still `'wanted'` →
  Phase A: `transitionMovie`/create a `Movie`/`ListMovie` row at `state: 'wanted'` for every
  about-to-be-attempted film, *before* calling Radarr, so a failed attempt is visible instead of
  silently retried forever → `upsertMovies` → Phase C: transition each to `added`/`pre_existing` or
  log a `radarr_add_failed` event, per Radarr's outcome → record a `SyncRun` → `reconcileList` for
  anything that dropped off → `reconcileWatched` if `removeOnWatch` (fed `getDiaryWatchedDates`, not
  the deprecated live scrape) → `applyPermanenceClaims` if `permanence` (must run after both
  reconciles — DESIGN.md §5) → `syncCollection` if `makeCollection`; dry-run writes no rows and
  skips all of the above; failures are recorded, never thrown), plus `syncListById`, `syncAll`,
  `syncDue`, and `startScheduler`. `forceReconcileWatched(userId)` is the manual "check watched now"
  path (Users page): forces that user's `refreshWatchedState` immediately (bypassing
  `watchedRefreshIntervalMin`'s due-check), then runs `reconcileWatched` against every enabled
  `removeOnWatch` list they own, without waiting for each list's own next sync.
- **`src/reconcile/index.ts`** — the keeper-rule (DESIGN.md §4-§6), built around one shared
  predicate: `hasClaim(movieId)`/`hasOrdinaryClaim(movieId)` (the latter excludes `removeOnWatch`
  lists — only used for cancelling a `watched` request). `reconcileList(list, currentTmdbIds)` flips
  `ListMovie.presentOnList` false for anything no longer scraped and restores it true for anything
  that reappears after being marked gone (logging a paired `left_list`/`restored_to_list`
  `MovieEvent` either way, for every film regardless of state); a `deleted` film that reappears is
  additionally revived to `wanted` (a real re-add, since Radarr no longer has it) so the scheduler's
  dedup lets the next sync retry it. Refuses to drop more than half of a list's currently-tracked
  films at once (min. 3) since that's more likely a broken scrape than a real edit. It also runs
  `cancelStaleDeletionRequests` for any film confirmed present this run, not just newly-returned
  ones — self-heals a request stranded by a bad scrape from before this existed; cancels
  `left_list`/`list_deleted`/`list_deactivated`/`manual_reopen` requests on *any* claim, `watched`
  requests only on an *ordinary* claim. `evaluateForDeletion`'s gate is `Movie.state === 'added'`,
  re-verified inside a transaction right before transitioning to `deletion_queued`, closing a race
  where an overlapping manual sync + scheduler tick could otherwise double-create a request.
  `reconcileWatched(list, diaryWatchedDates)` logs a `watch_dropped` event and queues a claimed film
  once its diary date postdates this list's `firstSeenAt` for it and no ordinary claim remains
  elsewhere (DESIGN.md §7). `applyPermanenceClaims(list)` pins every film a `permanence` list
  currently claims (`added`/`deletion_queued`) straight to `kept`, every sync — live, not just at
  list-deletion — auto-resolving a pending request to `kept` when coming from `deletion_queued`.
  `handleListDisabled(list)` (called from the lists route the instant `enabled` flips false) logs
  `list_deactivated` for every claim the list was holding, then evaluates each for deletion.
  `deleteList(id)` logs `list_deleted` for every member *before* deleting the list row, then deletes
  the list's mirrored Jellyfin collection if it had one (`makeCollection` + a recorded
  `jellyfinCollectionId` — never leaves a stranded BoxSet behind), then either transitions its
  Filmstrip-managed films straight to `kept` (if `List.permanence`; already-`kept` films are skipped,
  not re-pinned) or runs them through the keeper-rule with reason `list_deleted`.
  All funnel through the same internal keeper-rule check, opening a `pending` `DeletionRequest` (and
  unmonitoring in Radarr) for eligible candidates. `approveDeletion(id)`/`keepDeletion(id)` resolve
  a pending request and transition state to `deleted`/`kept` (approve always deletes the file — no
  longer a per-list toggle). `dropKeepStatus(movieId)` is the manual escape hatch: reopens a `kept`
  film with zero current claims into `deletion_queued` (reason `manual_reopen`). `DeletionRequest.
  reason` ∈ `left_list | watched | list_deleted | list_deactivated | manual_reopen`.
  `convertToManaged(movieId)` is the admin escape hatch for the other side of the provenance
  keystone: brings a `pre_existing` film under Filmstrip's management (`state` → `added`), then runs
  the same reconciliation a sync would already have done for that one film right now — zero current
  claims queues it immediately (reason `left_list`); an enabled `removeOnWatch` list already
  claiming it gets `reconcileWatched` called for real right away, so a stale diary watch queues it
  (reason `watched`) instead of waiting for that list's next sync. An `unwatchedOnly` claim needs no
  special-casing — its `ListMovie` row already exists, so `hasClaim` already counts it. Throws if
  the movie isn't `pre_existing`. `getSoleOwnerUserId(movieId)` looks at every `ListMovie` row ever
  created for a film and returns the single owning user's id if there is exactly one (used to scope
  non-admin deletion-queue access — see `src/server/routes/deletions.ts` below); null on zero or
  multiple owners, which reads as admin-only.
- **`src/server/`** — the REST API (M5) + GUI auth (M6). `app.ts` exports `createApp()` (an Express
  app, no `listen` — so tests drive it via supertest and `src/index.ts` binds the port; it also
  serves `web/dist` when that build exists, with an Express-5 `/*splat` catch-all for SPA
  deep-links); `http.ts` holds `HttpError`/`asyncHandler`/`parseId`/`parseBody` + central error
  middleware; `auth.ts` has `requireAuth`/`requireAdmin` (read the session cookie); `routes/*` are
  one router per resource (`auth`, `settings`, `users`, `lists`, `movies`, `deletions`, `syncRuns`,
  `sync`). `users.ts`'s `POST /:id/refresh-watched` (admin-only) calls `forceReconcileWatched` and
  returns `{userId, filmsKnownWatched, listsReconciled}` — the "check watched now" button. `movies.ts`'s
  `GET /` and `GET /:id/history` both include the film's current **claims**
  (`{listId, listLabel}[]`, DESIGN.md §5) alongside `sources`/history; `GET /:id/history` is a film's
  full `MovieEvent` log, oldest first, 404 if the id doesn't exist (DESIGN.md §4); `POST
  /:id/drop-keep` (admin-only, via `requireAdmin` applied to that one route) calls `dropKeepStatus`;
  `POST /:id/convert` (admin-only) calls `convertToManaged`, returning `{id, queued}` so the GUI can
  report whether it landed straight in the deletion queue. `deletions.ts` is no longer admin-only at
  the mount point (`app.ts`) — any authenticated user can `GET`/`approve`/`keep`, but a non-admin's
  `GET` is filtered, and a non-admin's `approve`/`keep` 403s, to requests for films whose sole owner
  (`getSoleOwnerUserId`, `src/reconcile/index.ts`) is that user; an admin sees/resolves everything,
  unfiltered. `lists.ts` rejects `permanence` combined with `unwatchedOnly`/`removeOnWatch` on both
  create and update (effective values = patch merged over the existing row / schema defaults), and
  calls `handleListDisabled` after a `PATCH` flips `enabled` true→false. Routers are thin — validate
  with zod, then call prisma or the existing scheduler/reconcile/auth functions. Everything under
  `/api` needs a session except `/api/health` and `POST /api/auth/login`; settings/users/global-sync
  are admin-only (deletions is ownership-scoped instead, per above). Prisma P2002/P2025 → 409/404.
- **`src/auth/`** — GUI auth logic (M6): `login()` (Jellyfin `authenticateByName` → find-or-provision
  a linked `User` → create a `Session`), `validateSession()`, `logout()`. Sessions are DB-backed
  (`Session` model), opaque token in an httpOnly cookie, 30-day expiry.
- **`web/`** — the React + Vite SPA (M6). `src/api.ts` (fetch wrapper, `credentials: 'include'`),
  `src/auth.tsx` (auth context calling `/api/auth/*`), `src/movieState.tsx` (shared `STATE_META`/
  `StateBadge`, so Movies and MovieHistory always agree on state labels/colors),
  `src/listFields.tsx` (shared per-list settings form; `permanence`/`unwatchedOnly`/`removeOnWatch`
  are mutually-exclusive checkboxes — picking one disables+clears the others), `src/pages/*` (Login,
  Lists, Movies, MovieHistory, Users, Deletions, SyncHistory, Settings). Users has a per-row "Check
  watched" button (`POST /users/:id/refresh-watched`) disabled when the user has neither a Letterboxd
  username nor a Jellyfin id linked (nothing to check yet). Movies and MovieHistory both
  show a film's current claiming lists and, when `state === 'kept'` with zero claims, an admin-only
  "Drop keep status" button (`POST /movies/:id/drop-keep`); when `state === 'pre_existing'`, an
  admin-only "Convert to Filmstrip control" button (`POST /movies/:id/convert`) reports back whether
  the film landed straight in the deletion queue. The Movies page also filters by owner, claiming
  list, and list type (derived client-side from each row's `sources`/`claims`, same as the existing
  Radarr-status/state dropdowns) and sorts by clicking any column header (toggles ascending/
  descending; a fresh column resets to ascending). `/movies/:id` (MovieHistory) is the app's
  first param-based route, reached via a `Link` from a film's title on the Movies page — the first
  in-content navigation in the app (everywhere else only the topbar `NavLink`s move between pages).
  Deletions is visible to every authenticated user now (not just admins) — the server-side scoping
  in `deletions.ts` is what actually narrows a non-admin's view, not a client-side hide. Admin-only
  pages/actions (Users, Settings) are still hidden from non-admins (`useAuth().me.isAdmin`), gated
  server-side too.
- **`src/index.ts`** — boots `startScheduler()` **and** the Express API (`createApp().listen(PORT)`).
  **`src/cli.ts`** / **`src/db/seed.ts`** — operator entry points.

## Conventions / gotchas

- **Never read config from `process.env` in app logic.** Process-level settings only (DATABASE_URL,
  LOG_LEVEL, NODE_ENV) come from env; everything else comes from the DB via `resolveListConfig`. (The
  old strict env singleton was removed — `src/util/logger.ts` reads `process.env.LOG_LEVEL` directly.)
- The Radarr `"letterboxd"` tag is intentional/global; keep it even though the project is now Filmstrip.
- `src/scraper/http.ts`'s `fetchWithRetry` falls back to curl on a 403 (Node's fetch is fingerprinted
  and blocked deterministically on some Letterboxd URLs, curl isn't — see the file's doc comment).
  This was the actual root cause of `removeOnWatch` silently never firing in production: the diary
  scrape (the only source `getDiaryWatchedDates`/`WatchedFilm.source: 'letterboxd_diary'` reads) was
  403ing on effectively every daily refresh, so the cache stayed empty. Confirmed live (comparing a
  manual, isolated `curl` call against the app's own request pattern from inside the same container)
  that curl itself can also come back 403 on Letterboxd's diary pages specifically — but a lone curl
  call succeeded reliably every time, while `fetch`-then-curl repeated 3x in ~1.5s failed every time.
  So once Node's `fetch` has 403'd once in a call, it is *not* retried on later attempts — it appears
  to actively re-trigger the block that then also catches the curl call riding right behind it — and
  a curl 403 is retried curl-only with backoff (`BASE_DELAY_MS` = 1500ms) instead of being surfaced
  on the first attempt or paired with another doomed `fetch`.
- Tests mock the Prisma client (`../db/client`), the scraper, and the Radarr/Jellyfin modules — no
  real DB or network in unit tests. `prisma generate` must run before typecheck/tests (CI does
  this). `tsc --noEmit` only checks `src/**/*.ts` excluding `*.test.ts` (see tsconfig `exclude`) —
  always also run `npm run test:unit` after a schema change, since ts-jest is what actually
  typechecks the test fixtures.
- Keep the upstream `src/scraper/*` modules close to upstream so their scraping fixes can be cherry-picked.
- **Letterboxd blocks, and the fetch ladder in `src/scraper/http.ts`.** Three rungs, each added
  because the one above it demonstrably fails:
  1. `fetch` — 403s on Letterboxd for whole stretches at a time. Once a host 403s, it is not probed
     again until a 30-min TTL lapses; that state is module-scoped **on purpose**. Re-probing per
     call meant a scrape's hundreds of film pages each fired a doomed `fetch` immediately followed
     by curl, which kept the block permanently hot.
  2. curl — clears what `fetch` can't (a TLS/HTTP client fingerprint false-positive), but *only* on
     unpaginated URLs.
  3. FlareSolverr — a real browser, and the only thing that gets page 2+. Confirmed live against
     `/films/popular/page/2/`, which has no account context at all: page 1 returns 200 to curl,
     page 2 returns 403 cold, with a page-1 session, and with a Referer — while a browser loads it
     from both a home and a cellular connection. Not the IP, not cookies, not the account.
     Deliberately last: it costs a browser navigation, and nothing but pagination needs it.

  A 403 from FlareSolverr is authoritative and returned without retrying. With no FlareSolverr URL
  set, multi-page lists silently stop at page 1 — the give-up warn says so explicitly.
- **Scrape cost is dominated by film pages, not pagination.** Resolving a link to a tmdbId means
  fetching that film's page; a 2,000-film watched history is ~30 page fetches and ~3,500 film
  fetches. `FilmCache` (`src/films/cache.ts`, injected via `ScrapeOptions.filmCache`) makes that a
  one-time cost. Anything that scrapes should pass it — `fetchMoviesFromUrl` and `DiaryScraper`
  both accept it, and the scheduler/watched-refresh call sites already do.
- **A full watched-state refresh takes minutes and must never sit inside an HTTP request.**
  `POST /api/users/:id/refresh-watched` returns `202` and runs detached (its rejection is caught and
  logged — nothing is awaiting it); the SPA reads `User.lastWatchedRefreshAt` to see it land. It
  previously awaited the whole thing and NPM's 60s gateway timeout turned a working refresh into a
  red error banner.
- Prisma is pinned to **v6** on purpose (v7 needs a native driver adapter + ESM; bad fit here).
- **npm scripts that pass a regex containing `|` to Jest must quote it** (e.g.
  `--testPathIgnorePatterns=\"itest|livetest\"`) — npm runs scripts through a real shell (bash on
  Linux/macOS, cmd on Windows) that treats an unquoted `|` as a pipe, silently breaking the script
  on every platform, not just one.
- Radarr accepts its API key via the `RADARR__AUTH__APIKEY` env var at first boot (no config.xml
  parsing needed) — used by `live-api-test.yml` to pre-seed a known key.
- Jellyfin's startup wizard has an undocumented quirk: `POST /Startup/User` 404s unless
  `GET /Startup/Configuration`, `GET /Startup/FirstUser`, and `GET /Startup/User` are called first
  (reproduced reliably across multiple fresh containers; root cause unconfirmed). See
  `live-api-test.yml` for the exact working sequence.

## Status

M1–M7 (the full initial roadmap) are done: DB-backed multi-list core, normalized films +
provenance, reconcile + deletion approval, Jellyfin integration, the REST API, the React SPA +
Jellyfin auth, and the single-container Docker build. The multi-stage `Dockerfile` builds the SPA +
backend and runs one Node process (migrate deploy → serve SPA + `/api`); SQLite persists on a
`/config` volume. It is deployed as a `filmstrip` service in the separate **Home_Lab_Setup** compose
repo (on Melchior, port 3004, `chrischammer/filmstrip:latest`, SQLite on `./config/filmstrip`), and
reachable through NPM at `https://filmstrip.magi-home.xyz` — the session cookie is `Secure`, so
plain `http://melchior.home:3004` drops it and can't log in. FlareSolverr (`http://flaresolverr:8191`)
already runs in that same stack and is what `Settings.flaresolverrUrl` should point at.

Deferred refinements (tracked, not built): per-user list-ownership scoping (any authed user sees all
lists — the deletion queue is now scoped by film ownership, per above, but lists themselves are
not); Quick Connect login; rewiring `unwatchedOnly` onto the `WatchedFilm` cache (still a live
per-call scrape — only `removeOnWatch` reads the cache so far); building `web/` in CI; a
periodic live-scrape smoke test (unit tests mock Letterboxd HTML, so a markup change can't be caught
by them); validating `makeCollection` against a real-media Jellyfin library.

GitHub workflows: `ci.yml` (backend typecheck + unit tests) runs on every push/PR; `live-api-test.yml`
(real Radarr/Jellyfin containers) runs on PRs touching the API client files or via `workflow_dispatch`;
`docker.yml` publishes `chrischammer/filmstrip` to Docker Hub automatically whenever a GitHub Release
is published (`DOCKERHUB_NAMESPACE`/`DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` are configured; also
runnable manually via `workflow_dispatch`) — see README "Publishing" for the cut-a-release steps
(bump `package.json`, tag `vX.Y.Z`, publish the Release). Neither CI job builds `web/` yet.
