import pino from 'pino';

// Logging is process-level config, intentionally decoupled from the strict
// (DB-backed) app config so importing the logger never triggers env validation.
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const logger = pino({
    level: LOG_LEVEL,
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true
        }
    }
});

export default logger;