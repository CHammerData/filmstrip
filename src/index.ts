require('dotenv').config();

import logger from './util/logger';
import { VERSION } from './util/version';
import { startScheduler } from './scheduler';
import { startWatchedStateScheduler } from './watched';
import { createApp, createHeadlessApp, RunMode } from './server/app';
import { seedFromEnv } from './db/seed';

/** Process-level config (allowed from env, unlike app config which lives in the DB). */
const PORT = Number(process.env.PORT) || 3000;

/**
 * gui (default) serves the React SPA + the full auth-gated /api; headless runs just the scheduler
 * and a /api/health endpoint for the Docker HEALTHCHECK — no UI, no auth. Anything other than
 * "headless" resolves to gui.
 */
function resolveMode(): RunMode {
  return process.env.FILMSTRIP_MODE?.toLowerCase() === 'headless' ? 'headless' : 'gui';
}

export async function main(): Promise<void> {
  const mode = resolveMode();
  logger.info(`Starting Filmstrip v${VERSION} in ${mode} mode.`);

  // Headless has no GUI to configure through, so env is the source of truth: (re)seed the DB from
  // env on every boot (idempotent upserts). gui mode never does this — it would clobber
  // GUI-managed Settings with blank env values.
  if (mode === 'headless') {
    await seedFromEnv();
  }

  startScheduler();
  startWatchedStateScheduler();

  const app = mode === 'headless' ? createHeadlessApp() : createApp();
  app.listen(PORT, () => {
    const surface = mode === 'headless' ? '/api/health only' : 'routes under /api + web UI';
    logger.info(`Listening on http://localhost:${PORT} (${surface}).`);
  });
}

// Only run main if this file is executed directly
if (require.main === module) {
  main().catch(logger.error);
}
