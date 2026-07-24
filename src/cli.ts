require('dotenv').config();

import prisma from './db/client';
import { syncAll, syncDue, syncListById, SyncResult } from './scheduler';
import { approveDeletion, keepDeletion } from './reconcile';
import logger from './util/logger';

function printResults(results: SyncResult[]) {
  if (results.length === 0) {
    logger.info('No lists synced.');
    return;
  }
  for (const r of results) {
    logger.info(
      `  list ${r.listId}: ${r.status}${r.dryRun ? ' [dry-run]' : ''} ` +
        `found=${r.found} added=${r.added} skipped=${r.skipped} failed=${r.failed}` +
        (r.error ? ` error="${r.error}"` : '')
    );
  }
}

async function listLists() {
  const lists = await prisma.list.findMany({ include: { user: true }, orderBy: { id: 'asc' } });
  if (lists.length === 0) {
    logger.info('No lists. Run `npm run seed` or add lists via the API/GUI.');
    return;
  }
  for (const l of lists) {
    logger.info(
      `  [${l.id}] ${l.label} — ${l.url} (${l.listType}) ` +
        `owner=${l.user.tag} enabled=${l.enabled} ` +
        `lastSynced=${l.lastSyncedAt ? l.lastSyncedAt.toISOString() : 'never'}`
    );
  }
}

async function listDeletions() {
  const requests = await prisma.deletionRequest.findMany({
    where: { status: 'pending' },
    include: { movie: true, triggeredByList: true },
    orderBy: { createdAt: 'asc' },
  });
  if (requests.length === 0) {
    logger.info('No pending deletion requests.');
    return;
  }
  for (const r of requests) {
    logger.info(
      `  [${r.id}] ${r.movie.title}${r.movie.year ? ` (${r.movie.year})` : ''} tmdb=${r.movie.tmdbId} ` +
        `reason=${r.reason}${r.triggeredByList ? ` list="${r.triggeredByList.label}"` : ''} ` +
        `since=${r.createdAt.toISOString()}`
    );
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  switch (cmd) {
    case 'sync-all':
      printResults(await syncAll());
      break;
    case 'sync-due':
      printResults(await syncDue());
      break;
    case 'sync': {
      const id = Number(arg);
      if (!Number.isInteger(id)) throw new Error('Usage: cli sync <listId>');
      printResults([await syncListById(id)]);
      break;
    }
    case 'lists':
      await listLists();
      break;
    case 'deletions':
      await listDeletions();
      break;
    case 'approve': {
      const id = Number(arg);
      if (!Number.isInteger(id)) throw new Error('Usage: cli approve <deletionRequestId>');
      await approveDeletion(id);
      logger.info(`Approved deletion request ${id}: deleted from Radarr.`);
      break;
    }
    case 'keep': {
      const id = Number(arg);
      if (!Number.isInteger(id)) throw new Error('Usage: cli keep <deletionRequestId>');
      await keepDeletion(id);
      logger.info(`Kept deletion request ${id}: film pinned, will never be queued again.`);
      break;
    }
    default:
      logger.info(
        'Usage: cli <sync-all | sync-due | sync <listId> | lists | deletions | approve <id> | keep <id>>'
      );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    logger.error(`CLI failed: ${e?.message ?? e}`);
    await prisma.$disconnect();
    process.exit(1);
  });
