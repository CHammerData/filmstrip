# Filmstrip

Sync Letterboxd watchlists and lists into [Radarr](https://radarr.video/) — **multi-list,
multi-user, and managed from one place** instead of one container per list.

> **Filmstrip is a fork** of [ryanpag3/lettarrboxd](https://github.com/ryanpag3/lettarrboxd), which is a
> headless daemon that syncs a single Letterboxd list per container via environment variables. This
> fork keeps the upstream's proven scraper + Radarr logic and rebuilds everything around it into a
> single DB-backed service: many lists, owned by many people, configured in a database (and soon a
> web GUI) rather than N sets of env vars. It's also a personal learning project.

## How it differs from upstream

| | Upstream | This fork |
| :-- | :-- | :-- |
| Lists per deployment | One (per container) | Many (rows in a DB) |
| Configuration | Environment variables | Database (`Settings` / `User` / `List`), seedable from env |
| Multiple lists | Run N containers | One service, one scheduler over all enabled lists |
| Attribution | — | Per-list `User` tag in Radarr, so you can tell whose request a movie was |
| State / dedup | `movies.json` on disk | Normalized `Movie` + `ListMovie` rows |
| Interface | Logs only | CLI, REST API, and a React web GUI (Jellyfin login) |
| Packaging | One container per list | One container serving the SPA **and** `/api` |

## Status

Early, under active development. **M1–M7** (the full initial roadmap) are done: DB-backed multi-list
core, normalized films + provenance, reconcile + deletion approval, Jellyfin integration, the REST
API, a **React web GUI with Jellyfin login**, and a **single-container Docker build**. Drive it via
the web UI, the CLI, or the `/api` endpoints below. The full milestone roadmap lives in
[PLAN.md](./PLAN.md), and the target data model + feature design in [DESIGN.md](./DESIGN.md).

> **Note:** the Jellyfin client (`src/api/jellyfin.ts`) is verified against a real
> `lscr.io/linuxserver/jellyfin` instance via `.github/workflows/live-api-test.yml` (see
> [src/api/jellyfin.livetest.ts](./src/api/jellyfin.livetest.ts)) — but that instance's library is
> empty (no media files), so wire compatibility is confirmed while real-media collection matching
> is not exercised end-to-end.

## Architecture

- **Backend** — TypeScript/Node. The upstream `src/scraper/*` and `src/api/radarr.ts` modules are
  reused, parameterized to take per-list options instead of reading globals.
- **Persistence** — SQLite via [Prisma](https://www.prisma.io/) (Prisma v6). The whole DB is a single
  file (`prisma/dev.db`), so there's no separate database server to run or back up.
- **Data model** ([prisma/schema.prisma](./prisma/schema.prisma)):
  - `Settings` — singleton: the Radarr + Jellyfin connections and global defaults (quality
    profile, root folder, minimum availability, check interval, dry-run).
  - `User` — a person; carries a Radarr tag for attribution, owns lists, and optionally a
    `letterboxdUsername`/`jellyfinUserId` for watched-state.
  - `List` — a Letterboxd URL owned by a `User`, with per-list overrides that fall back to
    `Settings`, plus behavior toggles (`deleteFiles`, `unwatchedOnly`, `removeOnWatch`,
    `makeCollection`/`collectionNameOverride`).
  - `SyncRun` — one row per sync attempt (status + counts + timing) → powers history/health.
  - `Movie` — a film normalized across lists by `tmdbId`, carrying the `addedByFilmstrip`
    provenance flag (true only when Filmstrip itself created it in Radarr), `pinned`, and a cached
    `jellyfinItemId`.
  - `ListMovie` — `List` <-> `Movie` join (replaces `movies.json`/`SyncedMovie`): membership,
    presence, and per-list `excluded`.
  - `DeletionRequest` — the approval-queue row a removal candidate sits in until a human approves
    (delete from Radarr) or keeps (pins it) it.
- **Config resolution** — for each sync, [src/db/config.ts](./src/db/config.ts) merges a list's
  non-null overrides over `Settings` defaults and assembles the Radarr tag set as
  `[userTag, "letterboxd", ...extraTags]`.
- **Reconcile + the keeper-rule** — [src/reconcile/index.ts](./src/reconcile/index.ts) runs after
  every sync. A film that's no longer on *any* enabled list (or, with `removeOnWatch`, that the
  owner has watched while still on the list), that Filmstrip itself added, that isn't pinned, and
  that carries no foreign Radarr tags is unmonitored and queued as a pending `DeletionRequest` for
  review — never deleted automatically. See [DESIGN.md §5-§6](./DESIGN.md).
- **Watched state + collections** — [src/watched/](./src/watched/) unions a user's Letterboxd
  watched films and Jellyfin playback history; [src/collections/](./src/collections/) mirrors a
  list's films into a Jellyfin BoxSet when `makeCollection` is on. See
  [DESIGN.md §7-§8](./DESIGN.md).

## Supported Letterboxd URLs

A list's type is detected automatically from its URL. All lists must be **public**.

| Type | URL shape |
| :-- | :-- |
| Watchlist | `https://letterboxd.com/username/watchlist/` |
| Regular list | `https://letterboxd.com/username/list/list-name/` |
| Watched movies | `https://letterboxd.com/username/films/` |
| Collection | `https://letterboxd.com/films/in/collection-name/` |
| Popular | `https://letterboxd.com/films/popular/` |
| Actor filmography | `https://letterboxd.com/actor/actor-name/` |
| Director filmography | `https://letterboxd.com/director/director-name/` |
| Writer filmography | `https://letterboxd.com/writer/writer-name/` |

## Development

### Prerequisites

- Node.js 20+ (developed on 26)
- npm (this fork uses npm + `package-lock.json`; upstream's `yarn.lock` was removed)

### Setup

```bash
git clone https://github.com/CHammerData/filmstrip.git
cd filmstrip
npm install

# Local config (gitignored). At minimum DATABASE_URL must be set.
cp .env.example .env

# Create the SQLite database from migrations + generate the Prisma client.
npx prisma migrate dev
```

`.env` for this fork:

```bash
DATABASE_URL="file:./dev.db"   # required by Prisma; resolves to prisma/dev.db
LOG_LEVEL=info
NODE_ENV=development
```

### Seeding (configure via env until the GUI exists)

`npm run seed` upserts the `Settings` row, a `User`, and one `List` from environment variables. It's
idempotent — safe to re-run. `DRY_RUN` defaults to `true` so the first run makes no changes in Radarr.

```bash
RADARR_API_URL=http://your-radarr:7878 \
RADARR_API_KEY=your_api_key \
RADARR_QUALITY_PROFILE="HD-1080p" \
LETTERBOXD_URL=https://letterboxd.com/your_username/watchlist/ \
DRY_RUN=true \
npm run seed
```

Optional seed vars: `RADARR_MINIMUM_AVAILABILITY`, `SEED_USER_NAME`, `SEED_USER_TAG`,
`SEED_LIST_LABEL`, `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `SEED_USER_LETTERBOXD_USERNAME`,
`SEED_USER_JELLYFIN_USER_ID` (the last four enable watched-state and collections — see
[DESIGN.md §7-§8](./DESIGN.md)). Behavior toggles like `unwatchedOnly`/`removeOnWatch`/
`makeCollection` aren't seedable — set them directly on the `List` row (e.g. via
`npm run prisma:studio`) until the API/GUI lands.

### CLI

```bash
npm run cli lists          # list configured lists + last-synced time
npm run cli sync <listId>  # sync one list now
npm run cli sync-all       # sync every enabled list now
npm run cli sync-due       # sync only lists whose interval has elapsed

npm run cli deletions      # show the pending deletion-review queue
npm run cli approve <id>   # approve: delete from Radarr (file too, if the list's deleteFiles is on)
npm run cli keep <id>      # keep: pin the film, it's never queued again
```

Movies are tagged in Radarr with the owning user's tag, the global `letterboxd` tag, and any per-list
extra tags. With `Settings.dryRun = true`, syncs log what *would* be added and write no `Movie`/
`ListMovie` rows (so a later real run still acts on them) and skip reconcile entirely. A true
dry-run still queries Radarr for quality profiles / root folders, so it needs a valid Radarr
connection.

A film that falls off every list it was on is never deleted outright — it's unmonitored in Radarr
(file kept) and shows up in `npm run cli deletions` for you to approve or keep.

### Running the scheduler + API

```bash
npm run start:dev   # boots the scheduler (ticks every minute, honoring each list's interval)
                    # AND the REST API (Express, PORT env, default 3000)
```

### Web GUI

A React + Vite SPA lives in [`web/`](./web/) (its own npm package). Sign in with a **Jellyfin
account** — the first login auto-provisions a linked Filmstrip user; Jellyfin admins get the
settings, users, deletion-queue, and global-sync screens. Screens: list management + per-list
config, users, the deletion-review queue, sync history, and connection settings.

```bash
cd web
npm install
npm run dev        # Vite dev server on :5173, proxies /api to the backend on :3000
npm run build      # emits web/dist, which the Express server serves in production
```

In production the backend serves the built SPA: run `npm run build` in `web/`, then
`npm run start` at the root — the Express server hosts `web/dist` alongside `/api` on the same port.

### REST API

All routes are served under `/api`. **Auth (M6):** every route except `GET /api/health` and
`POST /api/auth/login` requires a session cookie (obtained by logging in with a Jellyfin account);
settings, user management, the deletion queue, and global sync are admin-only. Errors come back as
`{ "error": "message" }` with an appropriate status (400 validation, 401 unauthenticated, 403
forbidden, 404 missing, 409 conflict).

| Method + path | Purpose |
| :-- | :-- |
| `GET /api/health` | Liveness check (public) |
| `POST /api/auth/login` \| `/logout`, `GET /api/auth/me` | Jellyfin login → session cookie; current user |
| `GET/PATCH /api/settings` | The singleton Radarr/Jellyfin connection + global defaults |
| `GET/POST /api/users`, `GET/PATCH/DELETE /api/users/:id` | Manage users |
| `GET/POST /api/lists`, `GET/PATCH/DELETE /api/lists/:id` | Manage lists (type auto-detected from the URL) |
| `POST /api/lists/:id/sync` | Sync one list now → returns the `SyncResult` |
| `POST /api/sync` (`?due=true`) | Sync all enabled lists now (or only those due) |
| `GET /api/deletions` (`?status=`) | The deletion-review queue (defaults to `pending`) |
| `POST /api/deletions/:id/approve` \| `/keep` | Resolve a pending deletion |
| `GET /api/sync-runs` (`?listId=&limit=`) | Sync history, newest first |

### Tests & typecheck

```bash
npm test               # all tests
npm run test:unit      # unit tests only (no network)
npm run test:integration   # integration tests (hit live Letterboxd)
npm run test:live      # exercises the Radarr/Jellyfin clients against real instances
npx tsc --noEmit       # typecheck
```

`test:live` skips cleanly (not a failure) unless `RADARR_TEST_URL`/`RADARR_TEST_API_KEY`/
`JELLYFIN_TEST_URL`/`JELLYFIN_TEST_API_KEY` are set. To run it locally: start a Radarr container
with `RADARR__AUTH__APIKEY` set (Radarr accepts its API key via that env var on first boot — no
config.xml parsing needed) plus a writable root folder, and a Jellyfin container with its
first-run setup wizard completed (see `.github/workflows/live-api-test.yml` for the exact,
verified sequence — Jellyfin's wizard has an undocumented quirk where `POST /Startup/User` 404s
unless a few `GET`s precede it).

### Prisma helpers

```bash
npm run prisma:migrate    # create/apply a migration in dev
npm run prisma:studio     # browse the DB in a local GUI
npm run prisma:generate   # regenerate the client
```

## Docker

The multi-stage [`Dockerfile`](./Dockerfile) builds the SPA and backend, then runs one Node process
that applies pending migrations (`prisma migrate deploy`) and serves the SPA + `/api` on port 3000.
The SQLite DB lives at `/config/filmstrip.db` — mount `/config` on a volume to persist it.

```bash
docker build -t filmstrip .
docker run -d --name filmstrip -p 3000:3000 \
  -v filmstrip-config:/config \
  filmstrip
# then open http://localhost:3000 and sign in with a Jellyfin account
```

`DATABASE_URL` defaults to `file:/config/filmstrip.db` and `PORT` to `3000` inside the image; other
config (Radarr/Jellyfin connections, defaults) is set at runtime via the **Settings** page or the
`/api/settings` endpoint, not env vars. In the Home Lab this runs as the `filmstrip` service in the
compose stack (one container, replacing the upstream one-container-per-list model).

## Troubleshooting

- **"Radarr connection is not configured"** — `Settings.radarrUrl` / `radarrApiKey` are unset. Re-run
  the seed with `RADARR_API_URL` and `RADARR_API_KEY`.
- **Quality profile errors** — the name must match Radarr exactly (case-sensitive).
- **No movies found** — confirm the Letterboxd list is public and the URL matches a supported shape.

## License

MIT — see [LICENSE](LICENSE). Original work © Ryan Page (upstream); fork modifications © Chris Hammer.

## Legal disclaimer

This project is intended for use with legally sourced media only. It helps users organize and manage
their personal media collections. The developers do not condone or support piracy in any form. Users
are solely responsible for ensuring their use of this software complies with all applicable laws and
regulations in their jurisdiction.
