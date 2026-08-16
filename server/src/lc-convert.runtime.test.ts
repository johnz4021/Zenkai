/**
 * Regression: zenkai.run 2026-08-15, palantir item-1 — a sourced build's
 * manifest carried no runtime/test_command (nothing ever mandated them), so
 * the validator ran the legacy vitest default on a python workspace. The
 * contract is now a stamped constant; these pin it to what every working
 * LC round already carries and what the session container actually runs.
 */
import { describe, expect, it } from 'vitest';
import { SOURCED_RUNTIME } from './lc-convert.js';

describe('SOURCED_RUNTIME', () => {
  it('is the python/unittest contract the conversion emits by construction', () => {
    expect(SOURCED_RUNTIME).toEqual({
      runtime: 'python',
      test_command: 'python3 -m unittest discover -v',
    });
  });
});
