import { main } from './index';
import * as scheduler from './scheduler';
import * as watched from './watched';
import { createApp, createHeadlessApp } from './server/app';
import { seedFromEnv } from './db/seed';

jest.mock('./util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('./scheduler');
jest.mock('./watched', () => ({ __esModule: true, startWatchedStateScheduler: jest.fn() }));
// Mock the apps so main() never binds a real port during the test.
jest.mock('./server/app', () => ({
  __esModule: true,
  createApp: jest.fn(),
  createHeadlessApp: jest.fn(),
}));
jest.mock('./db/seed', () => ({ __esModule: true, seedFromEnv: jest.fn() }));

describe('main application', () => {
  const listen = jest.fn((_port: number, cb: () => void) => cb());

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FILMSTRIP_MODE;
    (scheduler.startScheduler as jest.Mock).mockReturnValue({} as any);
    (watched.startWatchedStateScheduler as jest.Mock).mockReturnValue({} as any);
    (createApp as jest.Mock).mockReturnValue({ listen });
    (createHeadlessApp as jest.Mock).mockReturnValue({ listen });
    (seedFromEnv as jest.Mock).mockResolvedValue(undefined);
  });

  it('gui mode (default): starts the scheduler + full app, and does not auto-seed', async () => {
    await main();

    expect(scheduler.startScheduler).toHaveBeenCalledTimes(1);
    expect(watched.startWatchedStateScheduler).toHaveBeenCalledTimes(1);
    expect(createApp).toHaveBeenCalledTimes(1);
    expect(createHeadlessApp).not.toHaveBeenCalled();
    expect(seedFromEnv).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it('headless mode: auto-seeds from env, starts the scheduler + headless app', async () => {
    process.env.FILMSTRIP_MODE = 'headless';

    await main();

    expect(seedFromEnv).toHaveBeenCalledTimes(1);
    expect(scheduler.startScheduler).toHaveBeenCalledTimes(1);
    expect(watched.startWatchedStateScheduler).toHaveBeenCalledTimes(1);
    expect(createHeadlessApp).toHaveBeenCalledTimes(1);
    expect(createApp).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
