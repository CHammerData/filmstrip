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
- Design + roadmap nailed down (DESIGN.md / PLAN.md). Project renamed lettarrboxd → **filmstrip**
  (package, GitHub repo, local folder, remotes all updated).

## Next task: M2 — normalized films + provenance

Per [PLAN.md](./PLAN.md) / [DESIGN.md §3](./DESIGN.md):
- Replace the per-list `SyncedMovie` model with a normalized **`Movie`** (unique `tmdbId`) plus a
  **`ListMovie`** join (membership + presence + per-list `excluded`).
- Record **`addedByFilmstrip`** on `Movie` (true only when Filmstrip *created* the film in Radarr —
  `addMovie` returns `added` vs `skipped: already in Radarr`). This is the keystone for safe deletion.
- Update `src/scheduler/index.ts` dedup/recording to write `Movie`/`ListMovie` instead of `SyncedMovie`.
- New Prisma migration; update the scheduler tests accordingly.

M3 (reconcile + deletion approval queue) builds directly on this — see DESIGN.md §5–§6.

## Gotchas (also in CLAUDE.md)

- Config comes from the **DB**, not env. Only `DATABASE_URL`/`LOG_LEVEL`/`NODE_ENV` come from
  `process.env`. (The old strict env singleton was deleted.)
- **npm only** — don't run `yarn` (it would resurrect a competing lockfile; `yarn.lock` was removed).
- **Prisma pinned to v6** on purpose (v7 needs a native driver adapter + ESM; bad fit here).
- The Radarr `"letterboxd"` tag is intentional/global; keep it despite the rename.
- GitHub workflows: only `ci.yml` (typecheck + unit tests) runs automatically; Docker/scheduled/
  release ones are disabled to manual-only until M7.
- Local `dev.db` and `.env` are gitignored — each machine seeds its own.

## Note from the owner

This repo was scaffolded heavily with Claude as a learning project and is **not recommended for use
yet** — much of M1 is scaffolding/one-shot tweaks to be validated as the real feature set (DESIGN.md)
gets built out.
