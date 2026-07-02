-- AlterTable
ALTER TABLE "ListMovie" ADD COLUMN "removedFromListAt" DATETIME;

-- CreateTable
CREATE TABLE "DeletionRequest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "movieId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "triggeredByListId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "DeletionRequest_movieId_fkey" FOREIGN KEY ("movieId") REFERENCES "Movie" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeletionRequest_triggeredByListId_fkey" FOREIGN KEY ("triggeredByListId") REFERENCES "List" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_List" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "listType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "qualityProfile" TEXT,
    "rootFolderId" TEXT,
    "minimumAvailability" TEXT,
    "monitored" BOOLEAN NOT NULL DEFAULT true,
    "extraTags" TEXT,
    "takeAmount" INTEGER,
    "takeStrategy" TEXT,
    "checkIntervalMin" INTEGER,
    "deleteFiles" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "List_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_List" ("checkIntervalMin", "createdAt", "enabled", "extraTags", "id", "label", "lastSyncedAt", "listType", "minimumAvailability", "monitored", "qualityProfile", "rootFolderId", "takeAmount", "takeStrategy", "updatedAt", "url", "userId") SELECT "checkIntervalMin", "createdAt", "enabled", "extraTags", "id", "label", "lastSyncedAt", "listType", "minimumAvailability", "monitored", "qualityProfile", "rootFolderId", "takeAmount", "takeStrategy", "updatedAt", "url", "userId" FROM "List";
DROP TABLE "List";
ALTER TABLE "new_List" RENAME TO "List";
CREATE UNIQUE INDEX "List_userId_url_key" ON "List"("userId", "url");
CREATE TABLE "new_Movie" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tmdbId" INTEGER NOT NULL,
    "imdbId" TEXT,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "addedByFilmstrip" BOOLEAN NOT NULL DEFAULT false,
    "radarrMovieId" INTEGER,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Movie" ("addedByFilmstrip", "createdAt", "id", "imdbId", "radarrMovieId", "title", "tmdbId", "updatedAt", "year") SELECT "addedByFilmstrip", "createdAt", "id", "imdbId", "radarrMovieId", "title", "tmdbId", "updatedAt", "year" FROM "Movie";
DROP TABLE "Movie";
ALTER TABLE "new_Movie" RENAME TO "Movie";
CREATE UNIQUE INDEX "Movie_tmdbId_key" ON "Movie"("tmdbId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DeletionRequest_movieId_idx" ON "DeletionRequest"("movieId");

-- CreateIndex
CREATE INDEX "DeletionRequest_status_idx" ON "DeletionRequest"("status");
