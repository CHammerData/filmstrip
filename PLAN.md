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
- **M7 — Dockerize + deploy.** Single-container image (build the SPA, serve it + `/api` from one
  Node process); add a `filmstrip` service to the Home_Lab_Setup compose (replaces the
  N-container approach).

Per-list toggles land across M3 (deleteFiles) and M4 (unwatchedOnly, removeOnWatch, makeCollection)
rather than as a milestone of their own; permanence rides with whichever milestone adds list
deletion.

## Current status

M1-M6 are complete. Next up is **M7** — package everything into a single container image (build the
React SPA, serve it plus `/api` from one Node process) and wire a `filmstrip` service into the
Home_Lab_Setup compose. Per-user list-ownership scoping in the API/GUI (regular users seeing only
their own lists) is a tracked refinement, deferred out of M6.
