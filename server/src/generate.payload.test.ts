/**
 * Regression: zenkai.run 2026-08-15, amazon item-1 — a sourced build burned
 * its whole 40-turn budget writing nothing, claude -p exited 0, and
 * `ok: code === 0` masked the payload's error_max_turns; the operator saw
 * only the validator's downstream symptom ("problem.json missing").
 * inBandFailure makes the payload's verdict count without changing the
 * flow — the validator still rules on the artifact either way.
 */
import { describe, expect, it } from 'vitest';
import { inBandFailure } from './generate.js';

describe('inBandFailure', () => {
  it('a clean success payload is not a failure', () => {
    expect(inBandFailure(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 22 }))).toBeNull();
  });

  it('error_max_turns on exit 0 is the amazon shape — named, with turn count', () => {
    const out = inBandFailure(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, num_turns: 40 }));
    expect(out).toContain('error_max_turns');
    expect(out).toContain('40');
  });

  it('is_error wins regardless of subtype', () => {
    expect(inBandFailure(JSON.stringify({ is_error: true }))).toContain('is_error');
  });

  it('unparseable stdout falls through to the validator, never a failure here', () => {
    expect(inBandFailure('')).toBeNull();
    expect(inBandFailure('not json {')).toBeNull();
  });
});
