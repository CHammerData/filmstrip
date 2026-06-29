# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**Filmstrip** syncs Letterboxd watchlists/lists into Radarr. It is a fork of
[ryanpag3/lettarrboxd](https://github.com/ryanpag3/lettarrboxd) (a single-list, env-configured
daemon) being rebuilt into a **multi-list, multi-user, DB-backed service** managed via CLI today and
a REST API + React GUI later. See [PLAN.md](./PLAN.md) for the roadmap (M1–M5) and
[HANDOFF.md](./HANDOFF.md) for current status.

## Commands

- `npm install` — install deps (this fork uses **npm** + `package-lock.json`; upstream's `yarn.lock`
  was removed — do not run `yarn`, it would resurrect a competing lockfile)
- `npx prisma migrate dev` — create/apply migrations + generate the Prisma client (run after clone)
- `npm run seed` — bootstrap Settings/User/List from env vars (see `.env.example`)
- `npm run cli <sync-all | sync-due | sync <listId> | lists>` — drive syncs manually
- `npm run start:dev` — boot the scheduler (1-min tick, honors per-list intervals)
- `npm run test:unit` — unit tests (no network); `npm run test:integration` hits live Letterboxd
- `npx tsc --noEmit` — typecheck

## Architecture

Config lives in **SQLite via Prisma**, not env vars. The data model is in
[prisma/schema.prisma](./prisma/schema.prisma): `Settings` (singleton: Radarr connection + global
defaults), `User` (owns lists; carries a Radarr attribution tag), `List` (a Letterboxd URL with
per-list overrides that fall back to Settings), `SyncRun` (one row per sync attempt), `SyncedMovie`
(per-list dedup, replaces the old `movies.json`).

Module layout:
- **`src/scraper/`** — reused from upstream. `fetchMoviesFromUrl(url, take?, strategy?)` detects the
  list type and delegates to a per-type scraper. Stateless; takes params, reads no globals.
- **`src/api/radarr.ts`** — reused/parameterized. `createRadarrClient({url, apiKey})` builds an axios
  client; `upsertMovies(client, movies, options)` adds movies and returns an `UpsertSummary` of
  per-movie outcomes. No global/env reads.
- **`src/db/`** — `client.ts` (PrismaClient singleton) and `config.ts`
  (`resolveListConfig(list, settings)`: merges overrides over defaults, assembles tags as
  `[userTag, "letterboxd", ...extraTags]`, throws on missing Radarr connection / quality profile).
- **`src/scheduler/index.ts`** — `syncList` (scrape → dedup vs `SyncedMovie` → upsert → record a
  `SyncRun`; dry-run writes no dedup rows; failures are recorded, never thrown), plus `syncListById`,
  `syncAll`, `syncDue`, and `startScheduler`.
- **`src/index.ts`** — boots `startScheduler()`. **`src/cli.ts`** / **`src/db/seed.ts`** — operator entry points.

## Conventions / gotchas

- **Never read config from `process.env` in app logic.** Process-level settings only (DATABASE_URL,
  LOG_LEVEL, NODE_ENV) come from env; everything else comes from the DB via `resolveListConfig`. (The
  old strict env singleton was removed — `src/util/logger.ts` reads `process.env.LOG_LEVEL` directly.)
- The Radarr `"letterboxd"` tag is intentional/global; keep it even though the project is now Filmstrip.
- Tests mock the Prisma client (`../db/client`), the scraper, and the Radarr module — no real DB or
  network in unit tests. `prisma generate` must run before typecheck/tests (CI does this).
- Keep the upstream `src/scraper/*` modules close to upstream so their scraping fixes can be cherry-picked.
- Prisma is pinned to **v6** on purpose (v7 needs a native driver adapter + ESM; bad fit here).

## Status

M1 (DB-backed multi-list core) is done. There is **no Dockerfile/compose** — they're deferred to M5
(single-container build, written fresh for the new architecture). Most GitHub workflows are upstream
leftovers disabled to manual-only; only `ci.yml` (typecheck + unit tests) runs automatically.
