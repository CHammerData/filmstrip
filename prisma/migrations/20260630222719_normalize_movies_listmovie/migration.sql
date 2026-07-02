/*
  Warnings:

  - You are about to drop the `SyncedMovie` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "SyncedMovie";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "Movie" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tmdbId" INTEGER NOT NULL,
    "imdbId" TEXT,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "addedByFilmstrip" BOOLEAN NOT NULL DEFAULT false,
    "radarrMovieId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ListMovie" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "listId" INTEGER NOT NULL,
    "movieId" INTEGER NOT NULL,
    "presentOnList" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ListMovie_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ListMovie_movieId_fkey" FOREIGN KEY ("movieId") REFERENCES "Movie" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Movie_tmdbId_key" ON "Movie"("tmdbId");

-- CreateIndex
CREATE INDEX "ListMovie_listId_idx" ON "ListMovie"("listId");

-- CreateIndex
CREATE INDEX "ListMovie_movieId_idx" ON "ListMovie"("movieId");

-- CreateIndex
CREATE UNIQUE INDEX "ListMovie_listId_movieId_key" ON "ListMovie"("listId", "movieId");
