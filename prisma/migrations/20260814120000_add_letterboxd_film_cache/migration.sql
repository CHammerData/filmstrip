-- CreateTable: permanent slug -> film identity cache, so a scrape stops re-fetching every film
-- page to rediscover a mapping that never changes.
CREATE TABLE "LetterboxdFilm" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slug" TEXT NOT NULL,
    "tmdbId" TEXT NOT NULL,
    "imdbId" TEXT,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "letterboxdId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "LetterboxdFilm_slug_key" ON "LetterboxdFilm"("slug");
