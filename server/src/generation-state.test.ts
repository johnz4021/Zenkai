/**
 * The sweep verdict is what stands between an app restart and a false
 * "failed" on a healthy detached generation (QA ISSUE-003) — and a false
 * failed plus a retry click meant TWO agents writing the same directory.
 * Pure verdict + disk marker round-trips; liveness injected as a value.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearGeneratingMarker,
  generationProgress,
  readGeneratingMarker,
  sweepVerdict,
  writeGeneratingMarker,
} from './generation-state.js';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'genstate-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('generating marker', () => {
  it('round-trips pid and start time', () => {
    const d = scratch();
    writeGeneratingMarker(d, 4242, Date.parse('2026-08-02T12:00:00Z'));
    expect(readGeneratingMarker(d)).toEqual({ pid: 4242, started_at: '2026-08-02T12:00:00.000Z' });
    clearGeneratingMarker(d);
    expect(readGeneratingMarker(d)).toBeNull();
  });

  it('a corrupt marker reads as absent, never throws', () => {
    const d = scratch();
    writeFileSync(path.join(d, '.generating'), 'not json{');
    expect(readGeneratingMarker(d)).toBeNull();
  });
});

describe('sweepVerdict — restart must not kill healthy work (ISSUE-003)', () => {
  const marker = { pid: 1, started_at: '2026-08-02T12:00:00Z' };

  it('alive pid → leave the item generating', () => {
    expect(sweepVerdict({ marker, alive: true, hasTerminalMarker: false })).toBe('leave');
  });

  it('dead pid → a real orphan, mark failed', () => {
    expect(sweepVerdict({ marker, alive: false, hasTerminalMarker: false })).toBe('fail');
  });

  it('no marker at all (pre-marker era) → fail, the old behavior', () => {
    expect(sweepVerdict({ marker: null, alive: false, hasTerminalMarker: false })).toBe('fail');
  });

  it('terminal marker present → only clear the stale bookkeeping', () => {
    expect(sweepVerdict({ marker, alive: true, hasTerminalMarker: true })).toBe('clear-marker');
    expect(sweepVerdict({ marker: null, alive: false, hasTerminalMarker: true })).toBe('clear-marker');
  });
});

describe('generationProgress — honest numbers for the UI (ISSUE-007)', () => {
  it('counts real files, skips dotfiles and cache dirs, reads the phase from the manifest', () => {
    const d = scratch();
    writeGeneratingMarker(d, 1, Date.parse('2026-08-02T12:00:00Z'));
    mkdirSync(path.join(d, 'src'));
    mkdirSync(path.join(d, '__pycache__'));
    writeFileSync(path.join(d, 'src', 'a.ts'), '');
    writeFileSync(path.join(d, 'src', 'b.ts'), '');
    writeFileSync(path.join(d, '__pycache__', 'junk.pyc'), '');
    writeFileSync(path.join(d, '.validated'), '');
    let p = generationProgress(d);
    expect(p).toEqual({ since: '2026-08-02T12:00:00.000Z', files: 2, phase: 'building' });
    writeFileSync(path.join(d, 'problem.json'), '{}');
    p = generationProgress(d);
    expect(p.files).toBe(3);
    expect(p.phase).toBe('finalizing');
  });

  it('no marker → null since; empty dir → zero files, still building', () => {
    const d = scratch();
    expect(generationProgress(d)).toEqual({ since: null, files: 0, phase: 'building' });
  });
});
