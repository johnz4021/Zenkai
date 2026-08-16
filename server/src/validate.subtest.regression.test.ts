/**
 * Regression: zenkai.run 2026-08-15, rep-mstyfgqj — a generator-authored
 * suite used subTests, whose result lines are INDENTED and parameterized;
 * the column-anchored parse could not see them, so two fully-red test
 * methods counted as silently passing and a valid all_failing scaffold
 * ("Ran 11 tests … FAILED (errors=18)") was rejected twice as "2 of 11
 * pass". LC-emitted suites avoid subTests by contract (lc-convert.ts);
 * authored suites have no such guarantee, so the parser carries it.
 */
import { describe, expect, it } from 'vitest';
import { parseUnittestOutput } from './validate.js';

const REAL_SHAPE = `
test_send_returns_an_id (tests.test_sms_gateway.SendTest.test_send_returns_an_id) ... ERROR
  test_rejects_a_blank_body (tests.test_sms_gateway.ValidationTest.test_rejects_a_blank_body) (body="''") ... ERROR
  test_rejects_a_blank_body (tests.test_sms_gateway.ValidationTest.test_rejects_a_blank_body) (body="'   '") ... ERROR
  test_rejects_a_recipient (tests.test_sms_gateway.ValidationTest.test_rejects_a_recipient) (recipient='+') ... ERROR
test_accepts_one_segment (tests.test_sms_gateway.ValidationTest.test_accepts_one_segment) ... ERROR

----------------------------------------------------------------------
Ran 4 tests in 0.003s

FAILED (errors=5)
`;

describe('parseUnittestOutput — subTest awareness', () => {
  it('counts subTest-only methods as failing, deduped per method', () => {
    const out = parseUnittestOutput(REAL_SHAPE);
    expect(out.total).toBe(4);
    expect(out.failed).toHaveLength(4); // 4 methods red, not 5 subTest lines
    expect(out.failed.join('|')).toContain('test_rejects_a_blank_body');
    expect(out.failed.join('|')).toContain('test_rejects_a_recipient');
  });

  it('a passing subTest line is not a failure', () => {
    const out = parseUnittestOutput(
      '  test_x (tests.T.test_x) (n=1) ... ok\nRan 1 test in 0.001s\n\nOK\n',
    );
    expect(out.total).toBe(1);
    expect(out.failed).toHaveLength(0);
  });

  it('the historical column-0 shape still parses identically', () => {
    const out = parseUnittestOutput(
      'test_a (tests.T.test_a) ... ok\ntest_b (tests.T.test_b) ... FAIL\nRan 2 tests in 0.001s\n\nFAILED (failures=1)\n',
    );
    expect(out.total).toBe(2);
    expect(out.failed).toEqual(['tests > T > test_b']);
  });
});
