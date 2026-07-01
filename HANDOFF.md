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
- Design + roadmap nailed down (DESIGN.md / PLAN.md). Project renamed lettarrboxd → **filmstrip**
  (package, GitHub repo, local folder, remotes all updated).

## Next task: M5 — REST API

Per [PLAN.md](./PLAN.md):
- Express app wrapping the existing `src/scheduler`/`src/reconcile` functions — CRUD for
  `User`/`List`/`Settings`, a manual "sync now" endpoint (`syncListById`), deletion-queue endpoints
  (`GET` pending, `POST` approve/keep — already implemented as plain functions in
  `src/reconcile/index.ts`, just needs HTTP wiring), and `SyncRun` history.
- This is what M6 (web GUI) and the per-list toggle UI (`unwatchedOnly` etc., currently
  DB-edit-only) will sit on top of.
- No new Prisma migration expected — M5 is wiring, not data model.

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
