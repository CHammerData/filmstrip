# Filmstrip — Roadmap

The single source of truth for **what we're building and in what order**. For the *what/how* —
data model, the keeper-rule, deletion approval, Jellyfin auth — see [DESIGN.md](./DESIGN.md).

Filmstrip is a fork of [ryanpag3/lettarrboxd](https://github.com/ryanpag3/lettarrboxd) that turns a
single-list, env-configured daemon into a **multi-list, multi-user, DB-backed** service pushing
Letterboxd lists into Radarr — a complement to Jellyseerr, not a replacement.

## Key decisions

| Area | Choice | Why |
| :--- | :--- | :--- |
| Base | True fork of upstream | Keep attribution + cherry-pick upstream scraper/Radarr fixes |
| Backend | TypeScript/Node → Express API + scheduler | Reuse the working `src/scraper` + `src/api/radarr` modules |
| Frontend | React + Vite SPA | The main thing to learn; clean split from the API |
| Persistence | SQLite + Prisma (v6) | Typed schema + migrations; single-file DB fits one container |
| Packaging | One container: Express serves the SPA **and** `/api` | Collapses the upstream "N containers for N lists" model |
| Provenance | Only ever touch films Filmstrip added (`addedByFilmstrip`) | Never clobber Seerr/manual adds — see [DESIGN.md §2](./DESIGN.md) |
| Removal | Delete-by-default, behind a human **approval queue** | Avoid hoarding without risking accidental loss — [DESIGN.md §6](./DESIGN.md) |
| Identity/auth | Jellyfin accounts (username/password + Quick Connect) | Audience already has them; complements Seerr — [DESIGN.md §9](./DESIGN.md) |

## Milestones

- **M1 — DB-backed multi-list core (CLI).** ✅ *Done.* Parameterized scraper + Radarr modules;
  Prisma schema + migration; a scheduler that syncs N enabled lists from the DB; seed + CLI.
- **M2 — Normalized films + provenance.** ✅ *Done.* Replaced per-list `SyncedMovie` with a
  normalized `Movie` + `ListMovie` join; tracks `addedByFilmstrip` and list presence. The
  foundation for everything below.
- **M3 — Reconcile + deletion approval.** ✅ *Done.* The keeper-rule, the `DeletionRequest` queue,
  reconcile-on-sync, and CLI to review / approve / keep; `Movie.pinned`; the **deleteFiles** toggle.
  `permanence` is deferred — it only matters once a list can be deleted, which no milestone builds
  yet; it'll land alongside that.
- **M4 — Jellyfin integration.** ✅ *Done.* Connection in `Settings`; watched-state (Letterboxd ∪
  Jellyfin) driving the **unwatchedOnly** and **removeOnWatch** toggles; **makeCollection**
  (BoxSets). Verified against a live Jellyfin server via `live-api-test.yml` (empty library, so
  wire compatibility only — see HANDOFF.md).
- **M5 — REST API.** ✅ *Done.* Express app under `/api` (`src/server/`): CRUD for
  users/lists/settings, manual "sync now" (per-list + sync-all/due), deletion-queue endpoints
  (list/approve/keep), and `SyncRun` history — all wrapping the existing scheduler/reconcile
  functions. No auth yet (arrives with the GUI, M6); assumes a trusted local network.
- **M6 — Web GUI.** ✅ *Done.* React + Vite SPA in `web/` with **Jellyfin auth** (DB-backed
  sessions; first login auto-provisions a linked User): login, list management + per-list config,
  user management, the deletion-review queue, sync status + history, and a settings/connections
  page. Express serves the built SPA alongside `/api`.
- **M7 — Dockerize + deploy.** ✅ *Done.* Multi-stage `Dockerfile` builds the SPA + backend and
  runs one Node process that applies migrations (`prisma migrate deploy`) then serves the SPA +
  `/api`; SQLite lives on a `/config` volume. The `filmstrip` service is added to the
  Home_Lab_Setup compose (replacing the upstream N-container-per-list approach). Image publishing
  via `docker.yml` stays manual until Docker Hub secrets/namespace are set.

Per-list toggles land across M3 (deleteFiles) and M4 (unwatchedOnly, removeOnWatch, makeCollection)
rather than as a milestone of their own; permanence rides with whichever milestone adds list
deletion.

## Current status

**M1–M7 are complete** — the roadmap as originally scoped is done: a DB-backed, multi-list,
multi-user service with reconcile/deletion approval, Jellyfin integration, a REST API, a React GUI
with Jellyfin auth, and a single-container deploy.

Known follow-ups (tracked, not yet built): per-user list-ownership scoping (regular users currently
see all lists); `List.permanence` + list deletion; Quick Connect login; Letterboxd diary-RSS
watched signal; building `web/` in CI; and validating the Jellyfin `makeCollection` flow against a
library with real media.
