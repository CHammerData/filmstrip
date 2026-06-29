import { main } from './index';
import * as scheduler from './scheduler';

jest.mock('./util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('./scheduler');

describe('main application', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts the scheduler on boot', async () => {
    (scheduler.startScheduler as jest.Mock).mockReturnValue({} as any);

    await main();

    expect(scheduler.startScheduler).toHaveBeenCalledTimes(1);
  });
});
