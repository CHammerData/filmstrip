# Session handoff — M1 COMPLETE (2026-06-29)

Branch: `feat/multi-list-gui`. **Nothing committed yet** — first commit should bundle
PLAN.md, prisma/, package.json/package-lock.json, and all M1 code.

## M1 delivered: DB-backed multi-list core (no GUI)
- **103 unit tests pass** (`npm run test:unit`), **`npx tsc --noEmit` clean**.
- Package manager: **npm** (`package-lock.json`). Upstream `yarn.lock` removed (npm kept rewriting it; one lockfile only).
- **Prisma v6** (not v7 — v7 needs a native driver adapter + ESM; bad fit for CommonJS/Windows). Migration `20260628182624_init` applied; client generated.

### Files added
- `prisma/schema.prisma` + `prisma/migrations/` — data model (Settings/User/List/SyncRun/SyncedMovie).
- `src/db/client.ts` — PrismaClient singleton (memoized on globalThis for dev hot-reload).
- `src/db/config.ts` — `resolveListConfig(list, settings)`: merges List overrides over Settings defaults, assembles tags `[userTag, "letterboxd", ...extraTags]`, throws on missing Radarr conn / quality profile. Plus `config.test.ts`.
- `src/scheduler/index.ts` — `syncList` (scrape → dedup vs SyncedMovie → upsert → record SyncRun + SyncedMovie rows; dry-run writes nothing; failures recorded, never thrown), `syncListById`, `syncAll`, `syncDue` (per-list interval honored), `startScheduler` (1-min tick). Plus `index.test.ts`.
- `src/db/seed.ts` — seeds Settings/User/List from env (`npm run seed`). dry-run defaults true.
- `src/cli.ts` — `npm run cli <sync-all | sync-due | sync <id> | lists>`.

### Files changed
- `src/scraper/index.ts` — `fetchMoviesFromUrl(url, take?, strategy?)`, env import dropped.
- `src/api/radarr.ts` — `createRadarrClient({url,apiKey})` factory; `upsertMovies(client, movies, options)` returns an `UpsertSummary` (added/skipped/failed + per-movie results); `addMovie` returns an `AddResult`. No more env reads. `radarr.test.ts` updated to new signatures.
- `src/util/logger.ts` — reads `process.env.LOG_LEVEL` directly (was importing the strict env singleton, which `process.exit`ed on any entrypoint). `logger.test.ts` rewritten.
- `src/index.ts` — boots `startScheduler()` instead of the single setInterval. `index.test.ts` rewritten.
- `.gitignore` — prisma/dev.db, *.sqlite, web/.
- `.env` (gitignored) — `DATABASE_URL`, `LOG_LEVEL`, `NODE_ENV`.

### Verified (no-secrets smoke test)
seed → `cli lists` → `cli sync 1` → with no Radarr configured, `resolveListConfig` throws *before*
scraping, the failure is caught, a `failed` SyncRun is recorded, and `lastSyncedAt` advances. Local
`dev.db` then reset to a clean schema.

## Watch-outs / debt
- **`src/util/env.ts` + `env.test.ts` were deleted** (dead after the DB-config switch; the singleton
  was a `process.exit(1)` footgun). Config now comes from the DB; process-level settings
  (DATABASE_URL/LOG_LEVEL/NODE_ENV) are read from `process.env` directly.
- A **true end-to-end dry-run still queries the real Radarr** (quality profiles / root folders) even
  though it skips writes — needs the user's Radarr URL + API key in the Settings row. Run:
  `RADARR_API_URL=... RADARR_API_KEY=... RADARR_QUALITY_PROFILE=... LETTERBOXD_URL=... DRY_RUN=true npm run seed`
  then `npm run cli sync 1`.

## Next: M2 — REST API + scheduler wiring
Express CRUD for users/lists/settings; manual "sync now" endpoint (wraps `syncListById`); expose
SyncRun history. Then M3 (React GUI), M4 (users polish), M5 (Dockerize + add to Home_Lab_Setup compose).
