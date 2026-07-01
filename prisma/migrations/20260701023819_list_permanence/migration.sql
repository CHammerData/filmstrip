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
    "permanence" BOOLEAN NOT NULL DEFAULT false,
    "unwatchedOnly" BOOLEAN NOT NULL DEFAULT false,
    "removeOnWatch" BOOLEAN NOT NULL DEFAULT false,
    "makeCollection" BOOLEAN NOT NULL DEFAULT false,
    "collectionNameOverride" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "List_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_List" ("checkIntervalMin", "collectionNameOverride", "createdAt", "deleteFiles", "enabled", "extraTags", "id", "label", "lastSyncedAt", "listType", "makeCollection", "minimumAvailability", "monitored", "qualityProfile", "removeOnWatch", "rootFolderId", "takeAmount", "takeStrategy", "unwatchedOnly", "updatedAt", "url", "userId") SELECT "checkIntervalMin", "collectionNameOverride", "createdAt", "deleteFiles", "enabled", "extraTags", "id", "label", "lastSyncedAt", "listType", "makeCollection", "minimumAvailability", "monitored", "qualityProfile", "removeOnWatch", "rootFolderId", "takeAmount", "takeStrategy", "unwatchedOnly", "updatedAt", "url", "userId" FROM "List";
DROP TABLE "List";
ALTER TABLE "new_List" RENAME TO "List";
CREATE UNIQUE INDEX "List_userId_url_key" ON "List"("userId", "url");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
