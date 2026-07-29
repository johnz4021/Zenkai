import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Generated problems ALWAYS contain exactly one deliberately-failing test.
    // Without this exclusion every `npm test` at the root goes red the moment
    // a problem is generated, and the signal from our own suite is destroyed.
    // Spike dirs are throwaway and self-contained; they don't belong either.
    exclude: ['**/node_modules/**', '**/dist/**', 'problems/**', 'spikes/**'],
  },
});
