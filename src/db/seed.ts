require('dotenv').config();

import prisma from './client';
import { detectListType } from '../scraper';
import logger from '../util/logger';

/**
 * Seed the DB for M1 from environment variables, so a single list can be synced
 * before the GUI (M3) exists. Idempotent: re-running updates the same rows.
 *
 * Reads (all optional; missing Radarr values just leave Settings blank):
 *   RADARR_API_URL, RADARR_API_KEY, RADARR_QUALITY_PROFILE,
 *   RADARR_MINIMUM_AVAILABILITY, DRY_RUN,
 *   SEED_USER_NAME (default "chris"), SEED_USER_TAG (default "chris"),
 *   LETTERBOXD_URL (the list to monitor), SEED_LIST_LABEL.
 */
async function seed() {
  const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() === 'true';

  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    update: {
      radarrUrl: process.env.RADARR_API_URL ?? null,
      radarrApiKey: process.env.RADARR_API_KEY ?? null,
      defaultQualityProfile: process.env.RADARR_QUALITY_PROFILE ?? null,
      defaultMinimumAvailability: process.env.RADARR_MINIMUM_AVAILABILITY ?? 'released',
      dryRun,
    },
    create: {
      id: 1,
      radarrUrl: process.env.RADARR_API_URL ?? null,
      radarrApiKey: process.env.RADARR_API_KEY ?? null,
      defaultQualityProfile: process.env.RADARR_QUALITY_PROFILE ?? null,
      defaultMinimumAvailability: process.env.RADARR_MINIMUM_AVAILABILITY ?? 'released',
      dryRun,
    },
  });
  logger.info(`Seeded Settings (dryRun=${settings.dryRun}, radarr=${settings.radarrUrl ?? 'unset'}).`);

  const userName = process.env.SEED_USER_NAME ?? 'chris';
  const userTag = process.env.SEED_USER_TAG ?? 'chris';
  const user = await prisma.user.upsert({
    where: { tag: userTag },
    update: { name: userName },
    create: { name: userName, tag: userTag },
  });
  logger.info(`Seeded User "${user.name}" (tag=${user.tag}).`);

  const url = process.env.LETTERBOXD_URL;
  if (!url) {
    logger.warn('LETTERBOXD_URL not set — no list seeded. Set it and re-run, or add lists via the API/GUI.');
    return;
  }

  const listType = detectListType(url);
  if (!listType) {
    logger.error(`LETTERBOXD_URL "${url}" is not a supported Letterboxd list URL — no list seeded.`);
    return;
  }

  const label = process.env.SEED_LIST_LABEL ?? `${user.name}'s ${listType}`;
  const list = await prisma.list.upsert({
    where: { userId_url: { userId: user.id, url } },
    update: { listType, label },
    create: { userId: user.id, url, listType, label },
  });
  logger.info(`Seeded List "${list.label}" (id=${list.id}, type=${list.listType}).`);
}

seed()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    logger.error('Seed failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
