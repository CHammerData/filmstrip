-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "radarrUrl" TEXT,
    "radarrApiKey" TEXT,
    "defaultQualityProfile" TEXT,
    "defaultRootFolderId" TEXT,
    "defaultMinimumAvailability" TEXT NOT NULL DEFAULT 'released',
    "defaultCheckIntervalMin" INTEGER NOT NULL DEFAULT 60,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "List" (
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
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "List_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "listId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "moviesFound" INTEGER NOT NULL DEFAULT 0,
    "moviesAdded" INTEGER NOT NULL DEFAULT 0,
    "moviesSkipped" INTEGER NOT NULL DEFAULT 0,
    "moviesFailed" INTEGER NOT NULL DEFAULT 0,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    CONSTRAINT "SyncRun_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncedMovie" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "listId" INTEGER NOT NULL,
    "letterboxdSlug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "tmdbId" INTEGER,
    "addedToRadarr" BOOLEAN NOT NULL DEFAULT false,
    "radarrMovieId" INTEGER,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncedMovie_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_tag_key" ON "User"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "List_userId_url_key" ON "List"("userId", "url");

-- CreateIndex
CREATE INDEX "SyncRun_listId_startedAt_idx" ON "SyncRun"("listId", "startedAt");

-- CreateIndex
CREATE INDEX "SyncedMovie_listId_idx" ON "SyncedMovie"("listId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncedMovie_listId_letterboxdSlug_key" ON "SyncedMovie"("listId", "letterboxdSlug");
