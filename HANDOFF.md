# Filmstrip — Handoff / Pickup

Start here when resuming (e.g. a fresh Claude chat on another machine).

## What this is

**Filmstrip** — a fork of [ryanpag3/lettarrboxd](https://github.com/ryanpag3/lettarrboxd) being
rebuilt from a single-list env daemon into a multi-list, multi-user, DB-backed service that pushes
Letterboxd lists into Radarr. A complement to Jellyseerr, not a replacement.

- Repo: `CHammerData/filmstrip` · working branch: **`feat/multi-list-gui`** (not `main`).
- Read these first, in order: **[DESIGN.md](./DESIGN.md)** (data model + feature design),
  **[PLAN.md](./PLAN.md)** (the roadmap, M1–M7), **[CLAUDE.md](./CLAUDE.md)** (conventions/gotchas).

## Get running on a fresh machine

```bash
git clone https://github.com/CHammerData/filmstrip.git
cd filmstrip
git checkout feat/multi-list-gui
npm install                 # uses npm + package-lock.json (NOT yarn)
cp .env.example .env        # has DATABASE_URL="file:./dev.db"
npx prisma migrate dev      # creates prisma/dev.db + generates the client
npm run test:unit           # sanity: should be green
```

Then optionally seed + drive it (see README for the full env list):
```bash
RADARR_API_URL=... RADARR_API_KEY=... RADARR_QUALITY_PROFILE=... \
LETTERBOXD_URL=... DRY_RUN=true npm run seed
npm run cli lists
npm run cli sync <listId>
```

## Status

- **M1 ✅ done + committed** — DB-backed multi-list core (CLI-driven). Scraper + Radarr modules
  parameterized; Prisma (v6) schema/migration; DB-driven scheduler; seed + CLI. Unit tests green.
- **M2 ✅ done** — normalized films + provenance. `SyncedMovie` replaced with `Movie` (unique
  `tmdbId`, `addedByFilmstrip`) + `ListMovie` join (membership/presence/`excluded`). Scheduler
  dedups by `tmdbId` and upserts both rows; movies without a `tmdbId` are never persisted (always
  retried — cheap, since `upsertMovies` short-circuits them with no Radarr call). Migration
  `20260630222719_normalize_movies_listmovie`.
- **M3 ✅ done** — reconcile + deletion approval. New `src/reconcile/index.ts`: `reconcileList`
  runs at the end of every non-dry-run `syncList`, flips `ListMovie.presentOnList`/
  `removedFromListAt` for anything that dropped off, and runs the keeper-rule (DESIGN.md §5) on
  each — `addedByFilmstrip` + not still wanted by any enabled list + not `pinned` + no foreign
  Radarr tag → unmonitor in Radarr and open a `pending` `DeletionRequest`. CLI:
  `npm run cli deletions | approve <id> | keep <id>`. Added `Movie.pinned`, `List.deleteFiles`,
  `DeletionRequest` model, and `getMovieById`/`getAllTags`/`setMonitored`/`deleteMovie` to
  `src/api/radarr.ts`. Migration `20260630224152_deletion_approval_queue`. `List.permanence` was
  **deliberately not added** — it only matters once list deletion exists, which no milestone
  builds yet (see PLAN.md's per-list-toggles note); add it alongside that feature instead.
- **M4 ✅ done** — Jellyfin integration. Added `Settings.jellyfinUrl`/`jellyfinApiKey`,
  `User.letterboxdUsername`/`jellyfinUserId`, `List.unwatchedOnly`/`removeOnWatch`/
  `makeCollection`/`collectionNameOverride`, `Movie.jellyfinItemId`. New modules:
  - `src/api/jellyfin.ts` — Jellyfin REST client (watched items, library provider-id listing,
    BoxSet CRUD). Initially written from API knowledge only; **since verified against a real
    `lscr.io/linuxserver/jellyfin` container** (see the live-API-test bullet below) — library was
    empty (no media files), so wire compatibility is confirmed but real-media collection matching
    isn't exercised end-to-end.
  - `src/watched/index.ts` — `getOwnerWatchedTmdbIds(user, settings)` unions Letterboxd (scrapes
    `/{username}/films/` via the existing scraper — not yet the diary RSS DESIGN.md mentions as a
    future optimization) and Jellyfin watched sets. Either source missing/erroring → empty, never
    throws.
  - `src/collections/index.ts` — `syncCollection(list, name)` resolves list films to Jellyfin item
    ids (cached on `Movie.jellyfinItemId`), then creates/diffs the named BoxSet.
  - `src/reconcile/index.ts` — `evaluateForDeletion` now takes a `{reason, triggeredByListId,
    requireNotWanted}` object instead of just a listId; `reconcileWatched(list, watchedTmdbIds)` is
    the new `removeOnWatch` entry point (reason `'watched'`, `requireNotWanted: false` — being
    watched is independently sufficient even if the film is still on the list).
  - `src/scheduler/index.ts` — `syncList` now: fetches watched state only if `unwatchedOnly` or
    `removeOnWatch` is on; filters the *add pipeline* by `unwatchedOnly` but keeps reconcile's
    "still on the list" check based on the raw scrape (unwatchedOnly filtering ≠ leaving the list);
    calls `reconcileWatched`/`syncCollection` after the existing `reconcileList` call, each
    independently try/caught so a Jellyfin hiccup never fails the core Radarr sync.
  - `src/db/seed.ts` / `.env.example` — `JELLYFIN_URL`, `JELLYFIN_API_KEY`,
    `SEED_USER_LETTERBOXD_USERNAME`, `SEED_USER_JELLYFIN_USER_ID`. The per-list toggles
    (`unwatchedOnly` etc.) have no seed/CLI path yet — same as `qualityProfile`/`takeAmount` etc.
    since M1, set via `npm run prisma:studio` until the API/GUI lands.
  - Migration `20260630232443_jellyfin_integration`.
  - **Gotcha hit this session:** `tsc --noEmit` excludes `*.test.ts` (see tsconfig), so it stayed
    green even with stale Prisma types in test fixtures after a schema change — `npm run test:unit`
    (ts-jest) is what actually catches those. Always run both after a migration.
- **Live Radarr/Jellyfin API testing added** (a follow-up to M4, same session). Docker was
  available locally (installed via `winget install OpenJS.NodeJS.LTS` + Docker Desktop was already
  present but not running) so the whole recipe below was interactively verified against real
  containers before being encoded into CI — not just written from documentation.
  - `.github/workflows/live-api-test.yml` (new): boots `lscr.io/linuxserver/radarr` and
    `lscr.io/linuxserver/jellyfin` (matching the images already used in the Home_Lab_Setup compose),
    configures both via their real APIs, then runs `npm run test:live`. Triggers on
    `workflow_dispatch` or a PR touching `src/api/radarr.ts`/`src/api/jellyfin.ts`/the livetest
    files/the workflow itself — not every push, since booting + wizard-configuring two media
    servers is much slower than the mocked unit suite.
  - New `*.livetest.ts` test category (alongside the existing `*.itest.ts` for live Letterboxd):
    `src/api/radarr.livetest.ts`, `src/api/jellyfin.livetest.ts`. Both skip cleanly (not a failure)
    via `describe.skip` when their `*_TEST_URL`/`*_TEST_API_KEY` env vars aren't set, so they're
    safe in a bare `npm test` without Docker. `jest.config.js`/`tsconfig.json` updated to
    recognize/exclude the new suffix; `package.json` got `test:live`.
  - **Radarr setup**: `RADARR__AUTH__APIKEY` env var pre-seeds the API key at first boot (no
    config.xml parsing needed); `RADARR__AUTH__METHOD=None` skips UI auth. Root folder needs
    `docker exec radarr mkdir -p /movies && chmod 777 /movies` — a host bind-mount + host-side
    `chmod` was tried first but permission propagation was flaky across Docker platforms; the
    `docker exec`-based approach is platform-independent and was the one actually verified.
  - **Jellyfin setup** (the wizard flow, verified end-to-end multiple times against fresh
    containers): `POST /Startup/Configuration` → `POST /Startup/RemoteAccess` → **an undocumented
    quirk**: `POST /Startup/User` reliably 404s unless `GET /Startup/Configuration`,
    `GET /Startup/FirstUser`, and `GET /Startup/User` are called first (root cause unconfirmed —
    not a simple warm-up race; a container still fresh from `/health`=200 for 160+ seconds of
    pure-POST retries never succeeded, but adding the three GETs unblocked it immediately every
    time it was tried). After that: `POST /Startup/Complete` → `POST /Users/AuthenticateByName`
    (needs an `X-Emby-Authorization: MediaBrowser Client="...", Device="...", DeviceId="...",
    Version="..."` header) → `POST /Auth/Keys?App=...` (returns 204, no body) →
    `GET /Auth/Keys` to read back the actual key (`Items[0].AccessToken`) for use as `X-Emby-Token`
    thereafter. All exact bodies/params are in the workflow file.
  - **Real bug found and fixed along the way**: `package.json`'s
    `"test:unit": "jest --testPathIgnorePatterns=itest|livetest"` broke on **every platform**
    (Windows cmd *and* Linux/macOS bash both treat unquoted `|` as a real pipe when npm hands the
    script to a shell) — fixed by quoting: `--testPathIgnorePatterns=\"itest|livetest\"`. Caught by
    actually running the command, not just eyeballing the script string.
- **M5 ✅ done** — REST API. New `src/server/`: `createApp()` (Express, no `listen`, so supertest
  drives it and `src/index.ts` binds the port) mounts one router per resource under `/api` —
  `settings` (singleton get/patch, auto-creates a blank row), `users` (CRUD), `lists` (CRUD with
  URL→listType detection + `POST /:id/sync`), `deletions` (list + approve/keep, wrapping
  `src/reconcile`), `sync-runs` (history), `sync` (`POST` sync-all, `?due=true` for sync-due).
  Routers are thin: zod validation via `parseBody`, then prisma or existing scheduler/reconcile
  calls; `http.ts` centralizes `HttpError`/`asyncHandler`/`parseId`/`parseBody` and the error
  middleware. Prisma P2002/P2025 → 409/404. **No auth** (deferred to M6, see DESIGN §9). `src/index.ts`
  now boots the scheduler AND the API (`PORT` env, default 3000). Added supertest; 32 route tests in
  `src/server/app.test.ts` (183 total). No Prisma migration — M5 is wiring, not data model.
  Smoke-tested against the real dev.db: server boots, returns the settings singleton, rejects a bad
  list URL with 400.
- **M6 ✅ done** — Web GUI + Jellyfin auth. Two decisions were the user's call this session:
  DB-backed sessions (over stateless JWT) and auto-provisioning a linked User on first login.
  - **Auth backend** (committed as a separate checkpoint, `e7ab6fb`): `Session` Prisma model
    (opaque token, isAdmin, 30-day expiry) + `User.jellyfinUserId` made unique;
    `api/jellyfin.authenticateByName`; `src/auth` (login/validate/logout + tag-deriving
    provisioning); `src/server/auth.ts` middleware (`requireAuth`/`requireAdmin`) reading an
    httpOnly cookie; `routes/auth.ts` (`/login`, `/logout`, `/me`). `app.ts` now gates `/api`:
    all-but-health-and-login need a session; settings/users/deletions/global-sync are admin-only.
    cookie-parser added.
  - **SPA** in `web/` — a **separate npm package** (React 18 + Vite 5 + react-router 6), not part
    of the root `tsconfig`/jest. `src/api.ts` (fetch wrapper, `credentials:'include'`),
    `src/auth.tsx` (context → `/api/auth/*`), `src/useLoad.ts`, `src/pages/*` (Login, Lists +
    per-list config incl. the M3/M4 toggles, Users, Deletions, SyncHistory, Settings). Admin pages
    hidden from non-admins in `App.tsx`. Dark theme in `styles.css`.
  - **Serving**: `createApp()` serves `web/dist` when present (static + `/*splat` SPA fallback) —
    Express 5 rejects a bare `'*'` route (path-to-regexp v8), which broke the backend suite once
    `web/dist` existed; the named splat is the fix. Dev instead uses Vite on :5173 proxying `/api`.
  - **Migration** `20260701000000_gui_sessions`. Authored via `migrate diff` + `migrate deploy`:
    `migrate dev` refuses to run non-interactively when a schema change carries a warning (here the
    new `jellyfinUserId` unique constraint), even with `--create-only`.
  - Verified: `web` `npm run build` (strict tsc + Vite bundle) is clean; 201 backend tests pass;
    end-to-end smoke test (real server) — `GET /`+`/lists` serve the SPA, `/api/health` 200,
    `/api/lists` unauthenticated 401, `/api/nope` 404.
  - **Deferred**: Quick Connect login; per-user list-ownership scoping (any authed user currently
    sees all lists — the API/GUI don't filter by owner yet).
- Design + roadmap nailed down (DESIGN.md / PLAN.md). Project renamed lettarrboxd → **filmstrip**
  (package, GitHub repo, local folder, remotes all updated).

## Next task: M7 — Dockerize + deploy

Per [PLAN.md](./PLAN.md):
- Single-container image: build the `web` SPA, then run one Node process serving `web/dist` + `/api`
  (createApp already serves the SPA when `web/dist` is present, so the Dockerfile just needs to
  build both and set `NODE_ENV=production`). Run `prisma migrate deploy` on start; persist the
  SQLite DB on a volume.
- Add a `filmstrip` service to the Home_Lab_Setup `docker-compose.yml` (replacing the upstream
  N-container-per-list model), and re-enable/point `docker.yml` at the real image (see its TODO).
- Consider building `web/` in CI (`ci.yml` doesn't yet) so the SPA is typechecked on PRs.

## Gotchas (also in CLAUDE.md)

- Config comes from the **DB**, not env. Only `DATABASE_URL`/`LOG_LEVEL`/`NODE_ENV` come from
  `process.env`. (The old strict env singleton was deleted.)
- **npm only** — don't run `yarn` (it would resurrect a competing lockfile; `yarn.lock` was removed).
- **Prisma pinned to v6** on purpose (v7 needs a native driver adapter + ESM; bad fit here).
- The Radarr `"letterboxd"` tag is intentional/global; keep it despite the rename.
- GitHub workflows: `ci.yml` (typecheck + unit tests) runs on every push/PR; `live-api-test.yml`
  (real Radarr/Jellyfin containers) runs on PRs touching the API client files or manually via
  `workflow_dispatch`; Docker image build / scheduled / release ones stay disabled to manual-only
  until M7.
- Local `dev.db` and `.env` are gitignored — each machine seeds its own.

## Note from the owner

This repo was scaffolded heavily with Claude as a learning project and is **not recommended for use
yet** — much of M1 is scaffolding/one-shot tweaks to be validated as the real feature set (DESIGN.md)
gets built out.
