import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Generated problems contain deliberately-failing tests (one planted
    // failure for debugging rounds, an ALL-red scaffold suite for OA rounds).
    // Without these exclusions every `npm test` at the root goes red the
    // moment a problem is generated, and the signal from our own suite is
    // destroyed. targets/ holds per-target generated problems (season
    // program); reps/ holds target-less practice problems (same reason);
    // spike dirs are throwaway and self-contained. The problem-dir patterns
    // are root-anchored on purpose, which is why .claude/ (agent worktrees —
    // full repo checkouts carrying their own generated problems) needs its
    // own recursive entry.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', 'problems/**', 'targets/**', 'reps/**', 'spikes/**'],
  },
});
