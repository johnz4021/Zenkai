import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import {
  FOCUS_CAP,
  TEST_SNIPPET_CAP,
  currentFocus,
  findFailingTest,
  namedOutOfContextFiles,
  outlineOf,
  renderFocus,
  renderRepoMap,
  testNameSegment,
} from './problem-view.js';

// Real shapes from the two rounds that exist: item-3's python unittest file
// and debugging-001's vitest suites.
const PY_TEST = `import unittest
from hydrator import Hydrator


class TestHydrator(unittest.TestCase):
    def test_partial_failure_rolls_back(self):
        h = Hydrator()
        with self.assertRaises(HydrationError):
            h.run(broken_source())
        self.assertEqual(h.completed, [])

    def test_ordering_is_stable(self):
        h = Hydrator()
        h.run(ok_source())
        self.assertEqual(h.completed, ['a', 'b'])
`;

const TS_TEST = `import { describe, expect, it } from 'vitest';

describe('expiry', () => {
  it('releases expired holds on sweep', () => {
    const ledger = build();
    ledger.sweep(NOW + HOUR);
    expect(ledger.available('sku-1')).toBe(5);
  });

  it('keeps unexpired holds intact', () => {
    const ledger = build();
    expect(ledger.available('sku-1')).toBe(3);
  });
});
`;

describe('testNameSegment', () => {
  it('takes the last dotted segment of a unittest name', () => {
    expect(testNameSegment('tests.test_hydrator.TestHydrator.test_partial_failure_rolls_back')).toBe(
      'test_partial_failure_rolls_back',
    );
  });

  it('takes the title after the last > for vitest names, dots preserved', () => {
    expect(testNameSegment('expiry > releases expired holds on sweep')).toBe(
      'releases expired holds on sweep',
    );
  });
});

describe('findFailingTest', () => {
  it('finds a unittest body and stops at the next test', () => {
    const found = findFailingTest(
      [{ rel: 'test_hydrator.py', content: PY_TEST }],
      'test_hydrator.TestHydrator.test_partial_failure_rolls_back',
    );
    expect(found?.rel).toBe('test_hydrator.py');
    expect(found?.snippet).toContain('def test_partial_failure_rolls_back');
    expect(found?.snippet).toContain('assertRaises');
    expect(found?.snippet).not.toContain('test_ordering_is_stable');
  });

  it('finds a vitest body by its quoted title', () => {
    const found = findFailingTest(
      [{ rel: 'test/expiry.test.ts', content: TS_TEST }],
      'expiry > releases expired holds on sweep',
    );
    expect(found?.snippet).toContain("it('releases expired holds on sweep'");
    expect(found?.snippet).toContain('sweep(NOW + HOUR)');
    expect(found?.snippet).not.toContain('keeps unexpired holds intact');
  });

  it('ignores non-test files even when they mention the name', () => {
    const found = findFailingTest(
      [
        { rel: 'src/notes.ts', content: 'covers releases expired holds on sweep' },
        { rel: 'test/expiry.test.ts', content: TS_TEST },
      ],
      'expiry > releases expired holds on sweep',
    );
    expect(found?.rel).toBe('test/expiry.test.ts');
  });

  it('returns null when nothing matches — the caller falls back, never guesses', () => {
    expect(findFailingTest([{ rel: 'test/expiry.test.ts', content: TS_TEST }], 'x > not there')).toBeNull();
  });

  it('caps the snippet', () => {
    const huge = `def test_big():\n${'    x = 1\n'.repeat(1_000)}`;
    const found = findFailingTest([{ rel: 'test_big.py', content: huge }], 'test_big');
    expect(found!.snippet.length).toBeLessThanOrEqual(TEST_SNIPPET_CAP + 40);
    expect(found!.snippet).toContain('truncated');
  });
});

describe('outlineOf', () => {
  it('lists declarations with line numbers', () => {
    const out = outlineOf('import x\n\nclass Hydrator:\n    def run(self):\n        pass\n\ndef helper():\n    pass\n');
    expect(out).toContain('3: class Hydrator:');
    expect(out).toContain('4: def run(self):');
    expect(out).toContain('7: def helper():');
    expect(out).not.toContain('import x');
  });

  it('degrades honestly when nothing declares', () => {
    expect(outlineOf('just prose\nno code here')).toBe('(no recognizable declarations)');
  });
});

describe('renderRepoMap', () => {
  it('names and sizes, no content', () => {
    const out = renderRepoMap([
      { rel: 'hydrator.py', lines: 378 },
      { rel: 'test_hydrator.py', lines: 265 },
    ]);
    expect(out).toContain('hydrator.py — 378 lines');
    expect(out).toContain('test_hydrator.py — 265 lines');
  });
});

describe('currentFocus', () => {
  const now = 1_000_000;
  const ev = (type: string, dtSec: number, payload: unknown): TraceEvent =>
    ({ session_id: 's', user_id: 'u', source: 'extension', seq: 0, ts: now - dtSec * 1000, type, payload }) as TraceEvent;

  it('the newest file_open wins — focus switches included', () => {
    const focus = currentFocus(
      [
        ev('file_open', 300, { path: 'a.py' }),
        ev('file_open', 60, { path: 'b.py', via: 'focus' }),
      ],
      now,
    );
    expect(focus?.path).toBe('b.py');
    expect(focus?.dwellMs).toBe(60_000);
  });

  it('attaches the newest view_range for the focused file only', () => {
    const focus = currentFocus(
      [
        ev('file_open', 120, { path: 'b.py', via: 'focus' }),
        ev('view_range', 90, { path: 'a.py', start: 1, end: 40 }),
        ev('view_range', 30, { path: 'b.py', start: 200, end: 260 }),
      ],
      now,
    );
    expect(focus?.range).toEqual({ start: 200, end: 260 });
  });

  it('null before any file event — blind stays honest', () => {
    expect(currentFocus([], now)).toBeNull();
  });
});

describe('renderFocus', () => {
  it('small file: full content', () => {
    const out = renderFocus('a.py', 'def f():\n    return 1\n', 120_000, null);
    expect(out).toContain('── currently viewing: a.py (for ~2 min)');
    expect(out).toContain('return 1');
  });

  it('big file without a view range: outline, never a dump', () => {
    const big = Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? `def fn_${i}():` : '    x = 1')).join('\n');
    const out = renderFocus('hydrator.py', big, 0, null);
    expect(out.length).toBeLessThan(FOCUS_CAP);
    expect(out).toContain('structural outline');
    expect(out).toContain('def fn_0():');
  });

  it('big file WITH a view range: the lines on their screen, padded', () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = renderFocus('hydrator.py', big, 0, { start: 200, end: 240 });
    expect(out).toContain('on their screen: lines 200–240');
    expect(out).toContain('200: line 200');
    expect(out).toContain('180: line 180'); // the pad
    expect(out).not.toContain('line 300');
  });
});

describe('namedOutOfContextFiles (read_file instrumentation)', () => {
  const all = ['hydrator.py', 'docs/hydrator.md', 'test_hydrator.py', 'runner.py'];

  it('flags a named file whose content is not in context', () => {
    expect(namedOutOfContextFiles('should I be looking at runner.py?', all, ['hydrator.py'])).toEqual([
      'runner.py',
    ]);
  });

  it('matches spoken stems — transcripts rarely render ".py"', () => {
    expect(namedOutOfContextFiles('maybe the runner has it', all, ['hydrator.py'])).toEqual([
      'runner.py',
    ]);
  });

  it('stays quiet for in-context files and unrelated chatter', () => {
    expect(namedOutOfContextFiles('the hydrator retry looks wrong', all, ['hydrator.py'])).toEqual([]);
    expect(namedOutOfContextFiles('let me think for a second', all, ['hydrator.py'])).toEqual([]);
  });
});
