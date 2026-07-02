# Filmstrip

Sync Letterboxd watchlists and lists into [Radarr](https://radarr.video/) — **multi-list,
multi-user, managed from one place**

Point Filmstrip at any number of public Letterboxd lists (watchlists, custom lists, actor/director
filmographies, and more). It scrapes each on a schedule, adds the films to Radarr — tagged by whose
list they came from — and keeps things tidy: when a film drops off every list, it's unmonitored and
queued for your review rather than silently deleted.

> **Filmstrip is a fork** of [ryanpag3/lettarrboxd](https://github.com/ryanpag3/lettarrboxd) — a
> headless daemon that syncs one Letterboxd list per container via environment variables. This fork
> keeps upstream's proven scraper + Radarr logic and rebuilds around it: many lists, owned by many
> people, configured in a database and a web GUI (or still headless via env, if you prefer). It's
> early and under active development — expect rough edges.

## Why Filmstrip

| | Upstream lettarrboxd | Filmstrip |
| :-- | :-- | :-- |
| Lists per deployment | One per container | Many, in one service |
| Configuration | Environment variables | Web GUI + database (or env, headless) |
| Attribution | — | Per-user Radarr tag — know whose request a film was |
| State / dedup | `movies.json` on disk | Normalized `Movie` + `ListMovie` rows |
| Removals | — | Falls-off-list films queued for review, never auto-deleted |
| Interface | Logs only | Web GUI (Jellyfin login), REST API, and a CLI |
| Extras | — | Optional watched-state filtering + Jellyfin collections |

If only looking to sync your watchlist or a singular list [lettarrboxd](https://github.com/ryanpag3/lettarrboxd) is the proper choice.

## Quick start

Filmstrip ships as a single container that serves the web UI and the API on one port. The SQLite
database lives at `/config/filmstrip.db` — mount `/config` on a volume to persist it.

```bash
docker run -d --name filmstrip -p 3000:3000 \
  -v filmstrip-config:/config \
  chrischammer/filmstrip:latest
```

Open **http://localhost:3000**, sign in with a **Jellyfin account** (the first login auto-provisions
your Filmstrip user; Jellyfin admins get the settings/users/deletion screens), then:

1. **Settings** — enter your Radarr URL + API key and defaults (quality profile, root folder). Add
   a Jellyfin connection too if you want watched-state filtering or auto-collections.
2. **Lists** — add a public Letterboxd URL; the type is detected automatically. Set per-list options
   (interval, tags, behavior toggles).
3. Filmstrip syncs on a schedule from there. Dry-run is a global toggle so you can watch what it
   *would* do before it touches Radarr.

`docker-compose` example:

```yaml
services:
  filmstrip:
    image: chrischammer/filmstrip:latest
    ports:
      - "3000:3000"
    volumes:
      - filmstrip-config:/config
    restart: unless-stopped

volumes:
  filmstrip-config:
```

## Run modes: gui vs headless

`FILMSTRIP_MODE` (default `gui`) selects what the container runs:

- **`gui`** *(default)* — serves the React web UI + the full API. Configure everything through the
  UI after signing in with Jellyfin. **First-login bootstrap:** on a brand-new deploy there's no
  Jellyfin URL in the DB yet, and the Settings page that sets it is behind login — so set
  `JELLYFIN_URL` in the environment to enable that first sign-in. Once an admin saves the URL in
  Settings, the DB value wins and the env var is ignored.
- **`headless`** — no UI and no login: just the sync scheduler plus `/api/health`. There's no GUI to
  configure through, so **environment variables are the source of truth** — on every boot the
  container (re)seeds its database from the seed variables below. This is the closest analogue to
  upstream lettarrboxd's daemon; run one container per list, or seed several via the CLI.

```bash
docker run -d --name filmstrip \
  -e FILMSTRIP_MODE=headless \
  -e RADARR_API_URL=http://radarr:7878 \
  -e RADARR_API_KEY=your_api_key \
  -e RADARR_QUALITY_PROFILE="HD-1080p" \
  -e LETTERBOXD_URL=https://letterboxd.com/yourname/watchlist/ \
  -e DRY_RUN=false \
  -v filmstrip-config:/config \
  chrischammer/filmstrip:latest
```

### Configuration reference

| Variable | Applies to | Purpose |
| :-- | :-- | :-- |
| `FILMSTRIP_MODE` | both | `gui` (default) or `headless` |
| `PORT` | both | HTTP port inside the container (default `3000`) |
| `DATABASE_URL` | both | SQLite path (default `file:/config/filmstrip.db`) |
| `LOG_LEVEL` | both | `error` \| `warn` \| `info` (default) \| `debug` |
| `RADARR_API_URL`, `RADARR_API_KEY` | headless seed | Radarr connection |
| `RADARR_QUALITY_PROFILE` | headless seed | Must match Radarr exactly (case-sensitive) |
| `RADARR_MINIMUM_AVAILABILITY` | headless seed | `announced` \| `inCinemas` \| `released` |
| `LETTERBOXD_URL` | headless seed | The list to monitor |
| `JELLYFIN_URL`, `JELLYFIN_API_KEY` | headless seed | Optional: watched-state + collections |
| `DRY_RUN` | headless seed | `true` makes no Radarr changes (default `true`) |

In **gui** mode, Radarr/Jellyfin connections and defaults are set through the Settings page, not env
vars. The full set of seed variables lives in [`.env.example`](./.env.example).

### Health check

The image ships a Docker `HEALTHCHECK` polling `GET /api/health`, which returns
`{status, version, mode, uptime}` — `200` when the database is reachable, `503` (`status:"degraded"`)
when it isn't.

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

## How it works

Filmstrip is a TypeScript/Node service backed by a single SQLite file (via [Prisma](https://www.prisma.io/)),
so there's no separate database to run. Each sync scrapes a list, dedupes against what it's already
added, and pushes new films to Radarr tagged with the owning user's tag plus `letterboxd`. After
every sync a **reconcile** pass applies the *keeper-rule*: a film that's no longer on any enabled
list (and that Filmstrip itself added, isn't pinned, and carries no other Radarr tags) is unmonitored
and queued as a pending removal for a human to approve or keep — nothing is deleted automatically.
Optional per-list toggles add watched-state filtering and Jellyfin collection mirroring.

The full data model and design rationale live in **[DESIGN.md](./DESIGN.md)**; code layout and
conventions are in **[CLAUDE.md](./CLAUDE.md)**.

> **Note:** the Jellyfin client is verified against a real `lscr.io/linuxserver/jellyfin` instance in
> CI ([live-api-test.yml](./.github/workflows/live-api-test.yml)), but that instance's library is
> empty — so wire compatibility is confirmed while real-media collection matching isn't yet exercised
> end-to-end.

---

## Development

### Prerequisites

- Node.js 20+
- npm (this fork uses npm + `package-lock.json`)

### Setup

```bash
git clone https://github.com/CHammerData/filmstrip.git
cd filmstrip
npm install

cp .env.example .env         # local config (gitignored); at minimum set DATABASE_URL
npx prisma migrate dev       # create the SQLite DB + generate the Prisma client
npm run start:dev            # scheduler (ticks every minute) + REST API on :3000
```

### Local dev stack (filmstrip + Jellyfin + Radarr)

To click through the real UI, [`docker-compose.dev.yml`](./docker-compose.dev.yml) brings up
filmstrip (built from source) alongside **throwaway** Jellyfin and Radarr containers — for local
development only, not production.

```bash
docker compose -f docker-compose.dev.yml up -d --build
bash scripts/dev-setup.sh    # Windows: run in Git Bash
# open http://localhost:3000  →  log in with  admin / DemoPass123!
```

`scripts/dev-setup.sh` does the two imperative steps compose can't: it completes Jellyfin's first-run
wizard and seeds filmstrip's Settings (pointed at the compose Jellyfin + Radarr) plus a demo list.
It's idempotent. Dry-run is seeded **on**; toggle it off on the Settings page for a live sync.
Override creds/list with `JF_USER`, `JF_PASS`, `LIST_URL`. Host ports: **3000** (filmstrip),
**8096** (Jellyfin), **7878** (Radarr). Tear down with `down` (keeps volumes) or `down -v` (clean
slate).

### Seeding from env

`npm run seed` upserts a `Settings` row, a `User`, and one `List` from environment variables
(idempotent; `DRY_RUN` defaults to `true`). This is the same path headless mode uses on boot.

```bash
RADARR_API_URL=http://your-radarr:7878 \
RADARR_API_KEY=your_api_key \
RADARR_QUALITY_PROFILE="HD-1080p" \
LETTERBOXD_URL=https://letterboxd.com/your_username/watchlist/ \
npm run seed
```

Behavior toggles (`unwatchedOnly` / `removeOnWatch` / `makeCollection`) aren't seedable — set them on
the `List` row via the GUI/API or `npm run prisma:studio`.

### CLI

```bash
npm run cli lists          # list configured lists + last-synced time
npm run cli sync <listId>  # sync one list now
npm run cli sync-all       # sync every enabled list now
npm run cli sync-due       # sync only lists whose interval has elapsed
npm run cli deletions      # show the pending deletion-review queue
npm run cli approve <id>   # approve: delete from Radarr (file too, if the list's deleteFiles is on)
npm run cli keep <id>      # keep: pin the film so it's never queued again
```

### Web GUI

The React + Vite SPA lives in [`web/`](./web/) (its own npm package). In production the backend
serves the built bundle; in dev, run Vite alongside the API:

```bash
cd web
npm install
npm run dev        # Vite dev server on :5173, proxies /api to the backend on :3000
npm run build      # emits web/dist, which the Express server serves in production
```

### REST API

All routes are under `/api`. Every route except `GET /api/health` and `POST /api/auth/login`
requires a session cookie (from a Jellyfin login); settings, user management, the deletion queue, and
global sync are admin-only. Errors are `{ "error": "message" }` with an appropriate status.

| Method + path | Purpose |
| :-- | :-- |
| `GET /api/health` | Liveness (public) — `{status, version, mode, uptime}`; `503` when the DB is unreachable |
| `POST /api/auth/login` \| `/logout`, `GET /api/auth/me` | Jellyfin login → session cookie; current user |
| `GET/PATCH /api/settings` | Radarr/Jellyfin connection + global defaults |
| `GET/POST /api/users`, `GET/PATCH/DELETE /api/users/:id` | Manage users |
| `GET/POST /api/lists`, `GET/PATCH/DELETE /api/lists/:id` | Manage lists (type auto-detected) |
| `POST /api/lists/:id/sync` | Sync one list now → returns the `SyncResult` |
| `POST /api/sync` (`?due=true`) | Sync all enabled lists now (or only those due) |
| `GET /api/deletions` (`?status=`) | The deletion-review queue (defaults to `pending`) |
| `POST /api/deletions/:id/approve` \| `/keep` | Resolve a pending deletion |
| `GET /api/sync-runs` (`?listId=&limit=`) | Sync history, newest first |

### Tests & typecheck

```bash
npm run test:unit          # unit tests (no network)
npm run test:integration   # hits live Letterboxd
npm run test:live          # exercises Radarr/Jellyfin clients against real instances (skips unless *_TEST_* env set)
npx tsc --noEmit           # typecheck
```

### Building the image locally

```bash
docker build -t filmstrip .
```

## Publishing (maintainers)

Images publish to Docker Hub (`chrischammer/filmstrip`) on **release**. One-time repo config:
variable `DOCKERHUB_NAMESPACE`, secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (write-scoped).

To cut a release:

1. Bump `version` in [`package.json`](./package.json) to `X.Y.Z` and commit.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Publish the GitHub Release for that tag. That fires [`docker.yml`](./.github/workflows/docker.yml),
   which verifies the tag matches `package.json`, builds `linux/amd64,linux/arm64`, and pushes
   `X.Y.Z`, `X.Y`, `X`, and `latest` (also runnable via workflow_dispatch).

The Docker Hub repository overview is a short, hand-written blurb that links back to this repo (kept
minimal so it never needs updating) — GitHub is the source of truth for docs. It isn't automated:
Docker Hub's description API rejects the personal access token used for image pushes.

## Troubleshooting

- **"Radarr connection is not configured"** — `Settings.radarrUrl` / `radarrApiKey` are unset. Set
  them on the Settings page (gui) or via `RADARR_API_URL` / `RADARR_API_KEY` (headless).
- **Quality profile errors** — the name must match Radarr exactly (case-sensitive).
- **No movies found** — confirm the Letterboxd list is public and the URL matches a supported shape.

## License

MIT — see [LICENSE](LICENSE). Original work © Ryan Page (upstream); fork modifications © Chris Hammer.

## Legal disclaimer

This project is intended for use with legally sourced media only. It helps users organize and manage
their personal media collections. The developers do not condone or support piracy in any form. Users
are solely responsible for ensuring their use of this software complies with all applicable laws and
regulations in their jurisdiction.
