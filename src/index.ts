require('dotenv').config();

import logger from './util/logger';
import { startScheduler } from './scheduler';

export async function main(): Promise<void> {
  startScheduler();
}

// Only run main if this file is executed directly
if (require.main === module) {
  main().catch(logger.error);
}
