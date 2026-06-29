# Lettarrboxd Manager — Project Plan

A fork of [ryanpag3/lettarrboxd](https://github.com/ryanpag3/lettarrboxd) that turns the
single-list, env-configured daemon into a **multi-list, multi-user, GUI-managed** service
that pushes Letterboxd watchlists and lists into Radarr.

> Learning project. Goal is to build a real web app on top of the proven scrape + Radarr
> primitives the upstream already nails.

## Decisions

| Area | Choice | Why |
| :--- | :--- | :--- |
| Base | True fork of upstream (this repo) | Keep attribution + ability to pull upstream scraper/Radarr fixes |
| Backend | Keep TypeScript/Node, evolve into Express API + scheduler | Reuse the existing `src/scraper` and `src/api/radarr` modules nearly as-is |
| Frontend | React + Vite SPA | The main thing to learn; clean split from the API |
| Persistence | SQLite + Prisma | Typed schema + migrations; single-file DB fits a home-lab container |
| Packaging | One container: Express serves the built SPA **and** `/api` | Collapses the upstream "N containers for N lists" model into one service |

## What we reuse vs. replace

**Reuse (the hard, working part):**
- `src/scraper/*` — `fetchMoviesFromUrl(url)` is already URL-driven and stateless; it only
  reads `env` for take amount/strategy. We parameterize those.
- `src/api/radarr.ts` — `upsertMovies(movies)` does all the Radarr work but reads quality
  profile / root folder / tags / monitored / dry-run from global `env`. We turn those into a
  per-list options object.

**Replace:**
- `src/util/env.ts` singleton config → DB-backed config (Settings + Lists + Users).
- `DATA_DIR/movies.json` dedup → `SyncedMovie` rows per list.
- Single `setInterval` loop in `src/index.ts` → scheduler that iterates all enabled lists.
- Headless → Express REST API + React GUI.

## Target layout

```
lettarrboxd/
├── src/                 # backend (evolves the existing app)
│   ├── scraper/         # REUSED — parameterized (take/strategy as args)
│   ├── api/radarr.ts    # REUSED — parameterized (per-list options)
│   ├── db/              # Prisma client + repositories
│   ├── server/          # Express app + REST routes
│   ├── scheduler/       # iterate enabled lists from DB
│   └── index.ts         # boot: start server + scheduler
├── prisma/
│   └── schema.prisma    # data model (below)
├── web/                 # React + Vite SPA (served as static by Express in prod)
└── PLAN.md
```

Root stays the backend (minimizes path churn vs. upstream so we can still cherry-pick fixes);
the SPA lives in `web/`.

## Data model (see `prisma/schema.prisma`)

- **Settings** — singleton: the Radarr connection + global defaults (quality profile, root
  folder, check interval, dry-run).
- **User** — a person (you / family / friend). Owns lists; carries a Radarr source tag for
  attribution (e.g. `chris`, `alice`).
- **List** — a Letterboxd URL to monitor, owned by a User. Per-list overrides for quality
  profile, root folder, tags, monitored state, take amount/strategy, and interval (fall back
  to Settings defaults when null).
- **SyncRun** — one row per sync of a list: counts (found/added/skipped/failed), status, error,
  timing. Powers the GUI's history/health view.
- **SyncedMovie** — dedup tracking per list (replaces `movies.json`): which Letterboxd entries
  we've already processed and whether they landed in Radarr.

## Milestones

- **M1 — DB-backed multi-list core (no GUI).** Parameterize scraper + Radarr modules; Prisma
  schema + migration; a scheduler that syncs N lists from the DB; prove it with seed data.
- **M2 — REST API + scheduler wiring.** Express CRUD for users/lists/settings; manual
  "sync now"; SyncRun history recorded.
- **M3 — Web GUI.** React SPA: list/user management, per-list config, sync status + history.
- **M4 — Users polish.** Source-tag automation, per-user views, enable/disable.
- **M5 — Dockerize + deploy.** Single-container image; add as `letterboxd-manager` service in
  the Home_Lab_Setup compose (replaces the N-container approach).

## Immediate next steps

1. Review/adjust the data model in `prisma/schema.prisma`.
2. `corepack enable` (yarn) or use npm; add Prisma; generate client + first migration.
3. Parameterize the scraper take/strategy and the Radarr options (the reuse seam).
4. Build the scheduler over the DB; seed one real list; dry-run end to end.
