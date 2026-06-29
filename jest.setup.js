// Test environment defaults.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Suppress logs during tests

// Guard: if any code calls process.exit during a test, fail loudly instead of
// silently killing the runner.
const mockExit = jest.spyOn(process, 'exit').mockImplementation((code) => {
  throw new Error(`process.exit called with ${code}`);
});

afterAll(() => {
  mockExit.mockRestore();
});
