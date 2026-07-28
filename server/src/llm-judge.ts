/**
 * The LLM half of the classifier: judge utterances against the spec.
 * Uses headless Claude Code (same auth story as the generator — decision 8).
 * Injectable everywhere; tests use a fake and never reach this file.
 */

import { spawn } from 'node:child_process';
import type { UtteranceJudge, UtteranceJudgment } from './classifier.js';

export const claudeJudge: UtteranceJudge = async (utterances, spec) => {
  const prompt = [
    'You are labeling candidate utterances from a technical interview.',
    'The problem spec was:',
    '---',
    spec,
    '---',
    'For EACH utterance below, decide:',
    '- clarifying_question: is it an interrogative that references an entity or behavior from the spec, asked to resolve ambiguity? (thinking aloud or rhetorical noises are NOT clarifying questions)',
    '- assumption_update: does it explicitly state an assumption the candidate is adopting?',
    '',
    'Utterances (JSON):',
    JSON.stringify(utterances),
    '',
    'Reply with ONLY a JSON array, one object per utterance:',
    '[{"seq": <seq>, "clarifying_question": <bool>, "assumption_update": <bool>}]',
  ].join('\n');

  const out = await new Promise<string>((resolve) => {
    const child = spawn('claude', ['-p', prompt, '--output-format', 'text', '--model', 'haiku'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });

  const match = out.match(/\[[\s\S]*\]/);
  if (!match) return utterances.map((u) => ({ seq: u.seq, clarifying_question: false, assumption_update: false }));
  try {
    const parsed = JSON.parse(match[0]) as UtteranceJudgment[];
    return utterances.map(
      (u) =>
        parsed.find((p) => p.seq === u.seq) ?? {
          seq: u.seq,
          clarifying_question: false,
          assumption_update: false,
        },
    );
  } catch {
    return utterances.map((u) => ({ seq: u.seq, clarifying_question: false, assumption_update: false }));
  }
};
