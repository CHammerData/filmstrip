require('dotenv').config();

import logger from './util/logger';
import { startScheduler } from './scheduler';
import { createApp } from './server/app';

/** Process-level config (allowed from env, unlike app config which lives in the DB). */
const PORT = Number(process.env.PORT) || 3000;

export async function main(): Promise<void> {
  startScheduler();

  const app = createApp();
  app.listen(PORT, () => {
    logger.info(`API listening on http://localhost:${PORT} (routes under /api).`);
  });
}

// Only run main if this file is executed directly
if (require.main === module) {
  main().catch(logger.error);
}
