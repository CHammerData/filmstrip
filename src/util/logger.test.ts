describe('logger', () => {
  const ORIGINAL_LEVEL = process.env.LOG_LEVEL;

  afterEach(() => {
    if (ORIGINAL_LEVEL === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = ORIGINAL_LEVEL;
    }
    jest.resetModules();
  });

  it('should create a pino logger instance', () => {
    const logger = require('./logger').default;
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });

  it('should use the LOG_LEVEL from the environment', () => {
    jest.resetModules();
    process.env.LOG_LEVEL = 'debug';
    const logger = require('./logger').default;
    expect(logger.level).toBe('debug');
  });

  it('should default to info when LOG_LEVEL is unset', () => {
    jest.resetModules();
    delete process.env.LOG_LEVEL;
    const logger = require('./logger').default;
    expect(logger.level).toBe('info');
  });
});
