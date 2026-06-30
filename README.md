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
| State / dedup | `movies.json` on disk | `SyncedMovie` rows per list |
| Interface | Logs only | CLI today; REST API + React GUI on the roadmap |
| Packaging | One container per list | One container serving the SPA **and** `/api` |

## Status

Early, under active development. **M1 (DB-backed multi-list core) is done** — drive it via the CLI
below; there's no GUI or Docker image yet. The full milestone roadmap lives in [PLAN.md](./PLAN.md),
and the target data model + feature design in [DESIGN.md](./DESIGN.md).

## Architecture

- **Backend** — TypeScript/Node. The upstream `src/scraper/*` and `src/api/radarr.ts` modules are
  reused, parameterized to take per-list options instead of reading globals.
- **Persistence** — SQLite via [Prisma](https://www.prisma.io/) (Prisma v6). The whole DB is a single
  file (`prisma/dev.db`), so there's no separate database server to run or back up.
- **Data model** ([prisma/schema.prisma](./prisma/schema.prisma)):
  - `Settings` — singleton: the Radarr connection + global defaults (quality profile, root folder,
    minimum availability, check interval, dry-run).
  - `User` — a person; carries a Radarr tag for attribution; owns lists.
  - `List` — a Letterboxd URL owned by a `User`, with per-list overrides that fall back to `Settings`.
  - `SyncRun` — one row per sync attempt (status + counts + timing) → powers history/health.
  - `SyncedMovie` — per-list dedup (replaces `movies.json`).
- **Config resolution** — for each sync, [src/db/config.ts](./src/db/config.ts) merges a list's
  non-null overrides over `Settings` defaults and assembles the Radarr tag set as
  `[userTag, "letterboxd", ...extraTags]`.

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

### Seeding (M1: configure via env until the GUI exists)

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

Optional seed vars: `RADARR_MINIMUM_AVAILABILITY`, `SEED_USER_NAME`, `SEED_USER_TAG`, `SEED_LIST_LABEL`.

### CLI

```bash
npm run cli lists          # list configured lists + last-synced time
npm run cli sync <listId>  # sync one list now
npm run cli sync-all       # sync every enabled list now
npm run cli sync-due       # sync only lists whose interval has elapsed
```

Movies are tagged in Radarr with the owning user's tag, the global `letterboxd` tag, and any per-list
extra tags. With `Settings.dryRun = true`, syncs log what *would* be added and write no `SyncedMovie`
rows (so a later real run still acts on them). A true dry-run still queries Radarr for quality
profiles / root folders, so it needs a valid Radarr connection.

### Running the scheduler

```bash
npm run start:dev   # boots the scheduler: ticks every minute, honoring each list's interval
```

### Tests & typecheck

```bash
npm test               # all tests (unit + integration)
npm run test:unit      # unit tests only (no network)
npm run test:integration   # integration tests (hit live Letterboxd)
npx tsc --noEmit       # typecheck
```

### Prisma helpers

```bash
npm run prisma:migrate    # create/apply a migration in dev
npm run prisma:studio     # browse the DB in a local GUI
npm run prisma:generate   # regenerate the client
```

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
