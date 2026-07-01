import { main } from './index';
import * as scheduler from './scheduler';
import { createApp } from './server/app';

jest.mock('./util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('./scheduler');
// Mock the app so main() never binds a real port during the test.
jest.mock('./server/app', () => ({ __esModule: true, createApp: jest.fn() }));

describe('main application', () => {
  const listen = jest.fn((_port: number, cb: () => void) => cb());

  beforeEach(() => {
    jest.clearAllMocks();
    (createApp as jest.Mock).mockReturnValue({ listen });
  });

  it('starts the scheduler and the API server on boot', async () => {
    (scheduler.startScheduler as jest.Mock).mockReturnValue({} as any);

    await main();

    expect(scheduler.startScheduler).toHaveBeenCalledTimes(1);
    expect(createApp).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
