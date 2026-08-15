#!/usr/bin/env node
/**
 * seed-conversation — hand-author a planner proposal so /api/accept-spec can
 * be driven with full input control, model-free.
 *
 *   node qa/seed-conversation.mjs <target-id> <seed.json>
 *        │
 *        ├──► targets/<id>/target.json          (created if absent, empty specs)
 *        └──► targets/<id>/conversation.jsonl   (one assistant turn carrying a
 *                                                `propose_rounds` tool_use)
 *
 * Why it exists (doors QA, 2026-08-15): the conversational planner hard-501s
 * without ANTHROPIC_API_KEY by design, but accept-spec reads the STORED
 * proposal purely from disk (planner.ts latestProposal re-runs gatePlannerTurn
 * on load) — so a seeded conversation.jsonl exercises the real binder path:
 * named_problems, part_count, pace_per_week, topic freeze, per-item fan-out.
 * Faithful-to-prod limit: the proposal vocabulary has NO `task` field, so
 * eligibility on this door steers via capabilities, exactly as live.
 *
 * seed.json shape (everything but `rounds` optional):
 *   { "label": "QA plan", "pace_per_week": 4, "summary": "…",
 *     "topics": ["hash_map_indexing", "two_pointer_scan", …],   // 4-12 snake_case
 *                                       // slugs — STRINGS (gateConceptTopics'
 *                                       // tool-schema shape), never objects
 *     "rounds": [{ "id":"qa-oa","label":"QA OA","interviewer":false,
 *       "can_run_tests":true,"time_limit_minutes":60,"starts_from":"blank",
 *       "submit":"one_shot","surface":"panes","check_kind":"all_failing",
 *       "max_source_files":3,"emphasis":"","rationale":"seeded","unsupported":"",
 *       "named_problems":["two sum"],"part_count":3 }] }
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [targetId, seedPath] = process.argv.slice(2);
if (!targetId || !seedPath) {
  console.error('usage: node qa/seed-conversation.mjs <target-id> <seed.json>');
  process.exit(2);
}
const root = process.env.QA_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
if (!Array.isArray(seed.rounds) || seed.rounds.length === 0) {
  console.error('seed.json needs a non-empty rounds array');
  process.exit(2);
}

const dir = path.join(root, 'targets', targetId);
mkdirSync(dir, { recursive: true });

const targetPath = path.join(dir, 'target.json');
if (!existsSync(targetPath)) {
  // No user_id: with auth off the local user owns it (ownsTarget's ?? cfg.userId).
  writeFileSync(
    targetPath,
    JSON.stringify(
      {
        id: targetId,
        label: seed.label ?? `QA plan ${targetId}`,
        description: seed.description ?? 'Seeded by qa/seed-conversation.mjs for a doors-QA run.',
        // Field is `created` (intake.ts Target) — `created_at` here once broke
        // listTargets' sort and 500'd every target-listing door in the app.
        created: new Date().toISOString(),
        specs: [],
      },
      null,
      2,
    ) + '\n',
  );
}

const turn = {
  role: 'assistant',
  at: new Date().toISOString(),
  content: [
    { type: 'text', text: 'Seeded proposal (QA harness).' },
    {
      type: 'tool_use',
      id: `toolu_qaseed_${Date.now().toString(36)}`,
      name: 'propose_rounds',
      input: {
        rounds: seed.rounds,
        ...(seed.pace_per_week !== undefined ? { pace_per_week: seed.pace_per_week } : {}),
        summary: seed.summary ?? 'Seeded settled facts for a harness run.',
        ...(seed.topics ? { topics: seed.topics } : {}),
      },
    },
  ],
};
writeFileSync(path.join(dir, 'conversation.jsonl'), JSON.stringify(turn) + '\n');
console.log(`seeded ${targetId}: target.json + conversation.jsonl (${seed.rounds.length} round(s))`);
