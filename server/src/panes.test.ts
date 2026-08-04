/**
 * The panes helpers stand between the browser and the host filesystem —
 * safeWorkspacePath is the only thing stopping a crafted ?path= from
 * reading or writing outside the problem directory, and runGuard is the
 * only thing keeping one-shot OA rounds one-shot. Both get the paranoid
 * treatment.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RoundCapabilities } from '@interview-prep/shared';
import { isModelPath, listWorkspaceFiles, runGuard, safeWorkspacePath, summarizeTail } from './panes.js';

describe('safeWorkspacePath — the traversal gate', () => {
  const root = '/srv/problems/p-1';

  it('accepts plain and nested relative paths', () => {
    expect(safeWorkspacePath(root, 'main.py')).toBe('/srv/problems/p-1/main.py');
    expect(safeWorkspacePath(root, 'src/deep/mod.ts')).toBe('/srv/problems/p-1/src/deep/mod.ts');
  });

  it('rejects everything that would escape the root', () => {
    expect(safeWorkspacePath(root, '../escape')).toBeNull();
    expect(safeWorkspacePath(root, 'src/../../p-2/steal')).toBeNull();
    expect(safeWorkspacePath(root, 'foo/../../../etc/passwd')).toBeNull();
    expect(safeWorkspacePath(root, '/etc/passwd')).toBeNull();
    expect(safeWorkspacePath(root, '')).toBeNull();
    expect(safeWorkspacePath(root, '   ')).toBeNull();
  });

  it('a sibling directory sharing the root as a name prefix is outside', () => {
    // startsWith(root) alone would admit /srv/problems/p-1-evil.
    expect(safeWorkspacePath(root, '../p-1-evil/file')).toBeNull();
  });
});

describe('listWorkspaceFiles', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists candidate files, skips infrastructure and pipeline markers', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'panes-'));
    mkdirSync(path.join(dir, 'src'));
    mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, 'src/main.py'), 'x');
    writeFileSync(path.join(dir, 'problem.json'), '{}');
    writeFileSync(path.join(dir, '.validated'), '');
    writeFileSync(path.join(dir, '.used'), '');
    writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'x');
    expect(listWorkspaceFiles(dir)).toEqual(['problem.json', 'src/main.py']);
  });
});

describe('isModelPath', () => {
  it('matches with and without ./ prefixes on either side', () => {
    expect(isModelPath('src/main.py', ['./src/main.py'])).toBe(true);
    expect(isModelPath('./src/main.py', ['src/main.py'])).toBe(true);
    expect(isModelPath('src/other.py', ['src/main.py'])).toBe(false);
  });
});

describe('summarizeTail', () => {
  it('keeps the verdict pair from a vitest tail', () => {
    const tail = 'noise\n\n Test Files  1 failed (1)\n      Tests  3 failed | 5 passed (8)\n';
    expect(summarizeTail(tail)).toBe('Test Files  1 failed (1) — Tests  3 failed | 5 passed (8)');
  });

  it('keeps the verdict pair from a unittest tail', () => {
    expect(summarizeTail('....\nRan 8 tests in 0.01s\n\nFAILED (failures=3)\n')).toBe(
      'Ran 8 tests in 0.01s — FAILED (failures=3)',
    );
  });
});

describe('runGuard — one_shot stays one_shot', () => {
  const caps = (over: Partial<RoundCapabilities> = {}): RoundCapabilities => ({
    interviewer: false,
    can_run_tests: true,
    time_limit_ms: null,
    starts_from: 'blank',
    submit: 'iterate',
    ...over,
  });

  it('an iterate round, idle and live, may run', () => {
    expect(runGuard(caps(), false, false)).toBeNull();
  });

  it('a one_shot round may NEVER run outside Submit', () => {
    expect(runGuard(caps({ submit: 'one_shot' }), false, false)).toBe('one_shot');
  });

  it('no-run rounds, ended sessions, and in-flight runs are refused by name', () => {
    expect(runGuard(caps({ can_run_tests: false, submit: 'one_shot' }), false, false)).toBe('no_runs');
    expect(runGuard(caps(), true, false)).toBe('ended');
    expect(runGuard(caps(), false, true)).toBe('busy');
  });
});
