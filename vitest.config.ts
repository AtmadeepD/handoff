import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (whose root is src/public) so tests are actually discovered.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
  },
});
