-- Movie.state becomes the single source of truth for a film's lifecycle (DESIGN.md §10),
-- replacing the previously-scattered Movie.addedByFilmstrip / Movie.pinned booleans. Existing rows
-- are backfilled from those fields plus each movie's latest DeletionRequest, in this precedence:
--   1. pinned = true                          -> 'kept'          (covers keepDeletion AND the
--                                                                  deleteList permanence path,
--                                                                  which never created a request)
--   2. latest DeletionRequest.status='approved' -> 'deleted'
--   3. latest DeletionRequest.status='pending'  -> 'deletion_queued'
--   4. addedByFilmstrip = true                 -> 'added'
--   5. otherwise                               -> 'pre_existing'

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Movie" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tmdbId" INTEGER NOT NULL,
    "imdbId" TEXT,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'wanted',
    "radarrMovieId" INTEGER,
    "jellyfinItemId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Movie" ("id", "tmdbId", "imdbId", "title", "year", "state", "radarrMovieId", "jellyfinItemId", "createdAt", "updatedAt")
SELECT
    "id", "tmdbId", "imdbId", "title", "year",
    CASE
        WHEN "pinned" = 1 THEN 'kept'
        WHEN (SELECT "dr"."status" FROM "DeletionRequest" "dr" WHERE "dr"."movieId" = "Movie"."id" ORDER BY "dr"."createdAt" DESC LIMIT 1) = 'approved' THEN 'deleted'
        WHEN (SELECT "dr"."status" FROM "DeletionRequest" "dr" WHERE "dr"."movieId" = "Movie"."id" ORDER BY "dr"."createdAt" DESC LIMIT 1) = 'pending' THEN 'deletion_queued'
        WHEN "addedByFilmstrip" = 1 THEN 'added'
        ELSE 'pre_existing'
    END,
    "radarrMovieId", "jellyfinItemId", "createdAt", "updatedAt"
FROM "Movie";
DROP TABLE "Movie";
ALTER TABLE "new_Movie" RENAME TO "Movie";
CREATE UNIQUE INDEX "Movie_tmdbId_key" ON "Movie"("tmdbId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateTable
CREATE TABLE "MovieEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "movieId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT,
    "listId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MovieEvent_movieId_fkey" FOREIGN KEY ("movieId") REFERENCES "Movie" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MovieEvent_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MovieEvent_movieId_idx" ON "MovieEvent"("movieId");

-- Backfill: one synthetic event per existing movie so the history log has an honest starting
-- point instead of an unexplained gap before this migration.
INSERT INTO "MovieEvent" ("movieId", "type", "detail")
SELECT "id", 'backfilled', 'initial state inferred from legacy fields during migration'
FROM "Movie";
