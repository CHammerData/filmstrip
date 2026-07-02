import pino from 'pino';

// Logging is process-level config, intentionally decoupled from the strict
// (DB-backed) app config so importing the logger never triggers env validation.
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Human-friendly colorized output in dev; structured JSON to stdout in production (what log
// aggregators expect, and pino-pretty is a dev-only dependency we don't want in the hot path).
const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
    level: LOG_LEVEL,
    transport: isProduction
        ? undefined
        : {
              target: 'pino-pretty',
              options: {
                  colorize: true,
              },
          },
});

export default logger;