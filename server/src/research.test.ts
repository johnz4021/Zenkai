/**
 * The research parser is the citation gate: an uncited claim must never
 * survive into the target record, because the whole point of the agent is
 * that the candidate can audit every line.
 */
import { describe, expect, it } from 'vitest';
import { parseResearchOutput } from './research.js';

describe('parseResearchOutput', () => {
  it('keeps cited findings and the summary', () => {
    const out = parseResearchOutput(
      'Here is what I found:\n' +
        JSON.stringify({
          summary: 'The OA is 90 minutes on a hosted platform.',
          findings: [{ claim: '90-minute limit reported in 2025', url: 'https://example.com/t/1' }],
        }),
    );
    expect(out.findings).toHaveLength(1);
    expect(out.summary).toMatch(/90 minutes/);
  });

  it('drops uncited or mal-cited claims instead of passing them along', () => {
    const out = parseResearchOutput(
      JSON.stringify({
        summary: 'ok',
        findings: [
          { claim: 'no url at all' },
          { claim: 'not a link', url: 'glassdoor said so' },
          { claim: 'real', url: 'https://example.com/x' },
        ],
      }),
    );
    expect(out.findings).toEqual([{ claim: 'real', url: 'https://example.com/x' }]);
  });

  it('an empty findings list is a valid result — nothing found is honest', () => {
    const out = parseResearchOutput(JSON.stringify({ summary: 'Nothing public found.', findings: [] }));
    expect(out.findings).toEqual([]);
  });

  it('rejects output with no JSON or no summary', () => {
    expect(() => parseResearchOutput('I could not find anything.')).toThrow(/no JSON/);
    expect(() => parseResearchOutput('{"findings": []}')).toThrow(/summary/);
  });

  // Live failure: the model fenced its JSON and kept talking; a greedy
  // regex matched from the first { to a } past the object's end.
  it('survives fenced JSON with trailing prose (the live failure)', () => {
    const raw =
      'Here is what I found:\n```json\n' +
      JSON.stringify({ summary: 'A 90-minute OA.', findings: [{ claim: 'c', url: 'https://x.com/1' }] }) +
      '\n```\nLet me know if you need more. {unbalanced';
    const out = parseResearchOutput(raw);
    expect(out.summary).toBe('A 90-minute OA.');
    expect(out.findings).toHaveLength(1);
  });

  it('handles braces inside string values', () => {
    const raw = JSON.stringify({ summary: 'uses {curly} notation', findings: [] }) + ' trailing }';
    expect(parseResearchOutput(raw).summary).toBe('uses {curly} notation');
  });
});
