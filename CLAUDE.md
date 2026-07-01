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
| Provenance | Only ever touch films Filmstrip added (`addedByFilmstrip`) | Never clobber Seerr/manual adds — see [DESIGN.md §2](./DESIGN.md) |
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
connections, global defaults), `User` (owns lists; carries a Radarr attribution tag, plus
`letterboxdUsername`/`jellyfinUserId` for watched-state), `List` (a Letterboxd URL with per-list
overrides that fall back to Settings, plus `deleteFiles`/`unwatchedOnly`/`removeOnWatch`/
`makeCollection`/`collectionNameOverride`), `SyncRun` (one row per sync attempt), `Movie` (a film
normalized across lists by `tmdbId`, carrying the `addedByFilmstrip` provenance flag, `pinned`, and
`jellyfinItemId`), `ListMovie` (the `List`<->`Movie` join — membership, presence, per-list
`excluded` — replaces the old per-list `SyncedMovie`/`movies.json`), `DeletionRequest` (the
approval-queue row a removal candidate sits in until approved or kept).

Module layout:
- **`src/scraper/`** — reused from upstream. `fetchMoviesFromUrl(url, take?, strategy?)` detects the
  list type and delegates to a per-type scraper. Stateless; takes params, reads no globals.
- **`src/api/radarr.ts`** — reused/parameterized. `createRadarrClient({url, apiKey})` builds an axios
  client; `upsertMovies(client, movies, options)` adds movies and returns an `UpsertSummary` of
  per-movie outcomes; `getMovieById`/`getAllTags`/`setMonitored`/`deleteMovie` back the reconcile
  flow. No global/env reads.
- **`src/api/jellyfin.ts`** — `createJellyfinClient({url, apiKey})`; `getWatchedTmdbIds` (per-user
  played movies), `getAllMovieProviderIds` (library-wide tmdbId→item-id map), and the
  `findCollectionByName`/`createCollection`/`getCollectionItemIds`/`addToCollection`/
  `removeFromCollection` BoxSet helpers. Verified against a real `lscr.io/linuxserver/jellyfin`
  instance (`src/api/jellyfin.livetest.ts` + `live-api-test.yml`) — the library was empty (no media
  files) in that run, so wire compatibility (paths/params/auth/response shape) is confirmed but
  real-media collection matching is not exercised end-to-end.
- **`src/db/`** — `client.ts` (PrismaClient singleton) and `config.ts`
  (`resolveListConfig(list, settings)`: merges overrides over defaults, assembles tags as
  `[userTag, "letterboxd", ...extraTags]`, throws on missing Radarr connection / quality profile;
  also exports `parseExtraTags`/`GLOBAL_TAG`, reused by reconcile's foreign-tag check).
- **`src/watched/index.ts`** — `getOwnerWatchedTmdbIds(user, settings)`: unions a user's Letterboxd
  watched set (scrapes `/{username}/films/` via the scraper module) and Jellyfin watched set
  (`getWatchedTmdbIds`). Either source missing/failing degrades to empty, never throws.
- **`src/collections/index.ts`** — `syncCollection(list, collectionName)`: resolves each of the
  list's current films to a Jellyfin item id (cached on `Movie.jellyfinItemId` after the first
  lookup), then creates or diffs membership of the named BoxSet.
- **`src/scheduler/index.ts`** — `syncList` (scrape → optionally filter by watched state
  (`unwatchedOnly`) → dedup vs `ListMovie` (by `tmdbId`) → upsert → record a `SyncRun` plus
  `Movie`/`ListMovie` rows → `reconcileList` for anything that dropped off → `reconcileWatched` if
  `removeOnWatch` → `syncCollection` if `makeCollection`; dry-run writes no rows and skips all of
  the above; failures are recorded, never thrown), plus `syncListById`, `syncAll`, `syncDue`, and
  `startScheduler`.
- **`src/reconcile/index.ts`** — the keeper-rule (DESIGN.md §5-§6). `reconcileList(list,
  currentTmdbIds)` flips `ListMovie.presentOnList` for anything no longer scraped; `reconcileWatched
  (list, watchedTmdbIds)` queues anything still on the list the owner has watched. Both funnel
  through the same internal keeper-rule check, opening a `pending` `DeletionRequest` (and
  unmonitoring in Radarr) for eligible candidates. `approveDeletion(id)`/`keepDeletion(id)` resolve
  a pending request.
- **`src/server/`** — the REST API (M5) + GUI auth (M6). `app.ts` exports `createApp()` (an Express
  app, no `listen` — so tests drive it via supertest and `src/index.ts` binds the port; it also
  serves `web/dist` when that build exists, with an Express-5 `/*splat` catch-all for SPA
  deep-links); `http.ts` holds `HttpError`/`asyncHandler`/`parseId`/`parseBody` + central error
  middleware; `auth.ts` has `requireAuth`/`requireAdmin` (read the session cookie); `routes/*` are
  one router per resource (`auth`, `settings`, `users`, `lists`, `deletions`, `syncRuns`, `sync`).
  Routers are thin — validate with zod, then call prisma or the existing scheduler/reconcile/auth
  functions. Everything under `/api` needs a session except `/api/health` and `POST /api/auth/login`;
  settings/users/deletions/global-sync are admin-only. Prisma P2002/P2025 → 409/404.
- **`src/auth/`** — GUI auth logic (M6): `login()` (Jellyfin `authenticateByName` → find-or-provision
  a linked `User` → create a `Session`), `validateSession()`, `logout()`. Sessions are DB-backed
  (`Session` model), opaque token in an httpOnly cookie, 30-day expiry.
- **`web/`** — the React + Vite SPA (M6). `src/api.ts` (fetch wrapper, `credentials: 'include'`),
  `src/auth.tsx` (auth context calling `/api/auth/*`), `src/pages/*` (Login, Lists, Users,
  Deletions, SyncHistory, Settings). Admin-only pages are hidden from non-admins in `App.tsx`.
- **`src/index.ts`** — boots `startScheduler()` **and** the Express API (`createApp().listen(PORT)`).
  **`src/cli.ts`** / **`src/db/seed.ts`** — operator entry points.

## Conventions / gotchas

- **Never read config from `process.env` in app logic.** Process-level settings only (DATABASE_URL,
  LOG_LEVEL, NODE_ENV) come from env; everything else comes from the DB via `resolveListConfig`. (The
  old strict env singleton was removed — `src/util/logger.ts` reads `process.env.LOG_LEVEL` directly.)
- The Radarr `"letterboxd"` tag is intentional/global; keep it even though the project is now Filmstrip.
- Tests mock the Prisma client (`../db/client`), the scraper, and the Radarr/Jellyfin modules — no
  real DB or network in unit tests. `prisma generate` must run before typecheck/tests (CI does
  this). `tsc --noEmit` only checks `src/**/*.ts` excluding `*.test.ts` (see tsconfig `exclude`) —
  always also run `npm run test:unit` after a schema change, since ts-jest is what actually
  typechecks the test fixtures.
- Keep the upstream `src/scraper/*` modules close to upstream so their scraping fixes can be cherry-picked.
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
`/config` volume. Deploying it as a `filmstrip` service in the separate **Home_Lab_Setup** compose
repo is intended but **not yet done** (deliberately on hold).

Deferred refinements (tracked, not built): per-user list-ownership scoping (any authed user sees all
lists); `List.permanence` + list deletion; Quick Connect login; Letterboxd diary-RSS watched signal;
building `web/` in CI; validating `makeCollection` against a real-media Jellyfin library.

GitHub workflows: `ci.yml` (backend typecheck + unit tests) runs on every push/PR; `live-api-test.yml`
(real Radarr/Jellyfin containers) runs on PRs touching the API client files or via `workflow_dispatch`;
`docker.yml` builds/pushes the image but stays manual (`workflow_dispatch`) until Docker Hub
secrets/namespace are set. Neither CI job builds `web/` yet.
