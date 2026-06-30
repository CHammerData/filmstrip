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
- **M2 — Normalized films + provenance.** Replace per-list `SyncedMovie` with a normalized `Movie`
  + `ListMovie` join; track `addedByFilmstrip` and list presence. The foundation for everything below.
- **M3 — Reconcile + deletion approval.** The keeper-rule, the `DeletionRequest` queue, and CLI to
  review / approve / keep; `pinned`; the **permanence** and **deleteFiles** toggles.
- **M4 — Jellyfin integration.** Connection in `Settings`; watched-state (Letterboxd ∪ Jellyfin)
  driving the **unwatchedOnly** and **removeOnWatch** toggles; then **makeCollection** (BoxSets).
- **M5 — REST API.** Express CRUD for users/lists/settings; manual "sync now"; deletion-queue
  endpoints; `SyncRun` history.
- **M6 — Web GUI.** React SPA with **Jellyfin auth**: list/user management, per-list config, the
  deletion-review queue, sync status + history.
- **M7 — Dockerize + deploy.** Single-container image; add a `filmstrip` service to the
  Home_Lab_Setup compose (replaces the N-container approach).

Per-list toggles land across M3 (permanence, removeOnWatch, deleteFiles) and M4 (unwatchedOnly,
makeCollection) rather than as a milestone of their own.

## Current status

M1 is complete and committed. Next up is **M2** — normalizing to `Movie` + `ListMovie` and recording
`addedByFilmstrip`, which the keeper-rule and approval flow in M3 depend on.
