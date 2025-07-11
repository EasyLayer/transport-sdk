// Minimal setup for e2e tests
import 'reflect-metadata';

// Reduced timeout for faster tests
jest.setTimeout(60000); // Reduced from 120000

// Increase process listeners limit to avoid memory leak warnings
// process.setMaxListeners(100);

// Disable Node.js warnings for cleaner test output
process.env.NODE_NO_WARNINGS = '1';

// Handle uncaught exceptions gracefully in tests
process.on('uncaughtException', (error) => {
  console.error('[Jest Setup] Uncaught exception:', error.message);
  // Don't exit, let Jest handle it
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Jest Setup] Unhandled rejection:', reason);
  // Don't exit, let Jest handle it
});

// Global test environment setup
beforeAll(() => {
  // Ensure test environment
  process.env.NODE_ENV = 'test';
  process.env.TS_NODE_TRANSPILE_ONLY = 'true';
});

// Global cleanup after all tests
afterAll(() => {
  // Give time for cleanup
  return new Promise(resolve => setTimeout(resolve, 500));
});