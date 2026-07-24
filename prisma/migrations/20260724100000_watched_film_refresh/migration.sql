-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "watchedRefreshIntervalMin" INTEGER NOT NULL DEFAULT 1440;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastWatchedRefreshAt" DATETIME;

-- CreateTable
CREATE TABLE "WatchedFilm" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "watchedAt" DATETIME,
    "source" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WatchedFilm_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WatchedFilm_userId_idx" ON "WatchedFilm"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchedFilm_userId_tmdbId_key" ON "WatchedFilm"("userId", "tmdbId");
