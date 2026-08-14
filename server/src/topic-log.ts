/**
 * Plan-scoped topic outcome log — targets/<id>/topic-log.json.
 *
 *   session finalize / rejudge --record ──► recordTopicLogRow ──► topic-log.json
 *        (only when the manifest carries topics_exercised)            │
 *                                        rollupTopics (derived) ──► season page band
 *
 * Why plan-scoped storage: the vocabulary is plan-scoped (Target.topics,
 * frozen at confirm — see concept-topics.ts), so its outcomes live beside the
 * plan, not in a per-user store keyed on a global vocabulary that doesn't
 * exist. The LC ledger (topics/<uid>.json) is the sibling with the opposite
 * scope: global mechanical tags, LC rounds only. They never merge.
 *
 * Outcome v1 is deliberately coarse — {topics, solved} per session. Per-topic
 * per-dimension starves at this density, and "exercised but unsolved" +
 * "never exercised" already answers the question the band asks ("what do I
 * drill").
 *
 * The three sibling-store defects, fixed here by construction (the
 * topic-graph.ts prescriptions): upsert-by-session (rejudge is corrective,
 * never inflationary), tmp+fsync+rename saves (no torn JSON), validated
 * loads that THROW on corruption (returning empty would shadow-wipe history
 * on the next save) — record callers catch-and-warn, read callers degrade.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ConceptTopic } from './concept-topics.js';

export const TOPIC_LOG_VERSION = 1;

export interface TopicLogRow {
  /** THE idempotency key — one row per session, ever. Rejudge replaces. */
  session_id: string;
  /** assessment.judged_at. */
  ts: number;
  /** Subset of the plan's frozen topic ids (enforced upstream at the
   *  manifest patch site — this store trusts its writers). */
  topics: string[];
  solved: boolean | null;
}

export interface TopicLog {
  schema_version: number;
  target_id: string;
  rows: TopicLogRow[];
}

export function emptyTopicLog(targetId: string): TopicLog {
  return { schema_version: TOPIC_LOG_VERSION, target_id: targetId, rows: [] };
}

const logFile = (repoRoot: string, targetId: string): string =>
  path.join(repoRoot, 'targets', targetId, 'topic-log.json');

/** Pure upsert: replace by session_id, keep chronological by ts. */
export function upsertRow(log: TopicLog, row: TopicLogRow): TopicLog {
  const rows = log.rows.filter((r) => r.session_id !== row.session_id);
  rows.push(row);
  rows.sort((a, b) => a.ts - b.ts);
  return { ...log, rows };
}

/** Mechanical shape gate; returns human-readable failures, empty = valid. */
export function validateTopicLog(raw: unknown): string[] {
  const failures: string[] = [];
  const l = raw as Partial<TopicLog> | null;
  if (!l || typeof l !== 'object') return ['log is not an object'];
  if (l.schema_version !== TOPIC_LOG_VERSION) {
    failures.push(`schema_version ${String(l.schema_version)} — this build reads v${TOPIC_LOG_VERSION}; migrate before writing`);
  }
  if (typeof l.target_id !== 'string' || !l.target_id) failures.push('target_id missing');
  if (!Array.isArray(l.rows)) {
    failures.push('rows missing');
    return failures;
  }
  for (const r of l.rows) {
    if (typeof r?.session_id !== 'string' || !r.session_id) failures.push('row without session_id');
    if (typeof r?.ts !== 'number') failures.push(`row ${String(r?.session_id)}: ts missing`);
    if (!Array.isArray(r?.topics)) failures.push(`row ${String(r?.session_id)}: topics missing`);
    if (typeof r?.solved !== 'boolean' && r?.solved !== null) {
      failures.push(`row ${String(r?.session_id)}: solved must be boolean or null`);
    }
  }
  return failures;
}

/** Missing file → empty log. Corrupt or out-of-version → THROW (callers
 *  catch on record paths, degrade on read paths). */
export function loadTopicLog(repoRoot: string, targetId: string): TopicLog {
  let text: string;
  try {
    text = readFileSync(logFile(repoRoot, targetId), 'utf8');
  } catch {
    return emptyTopicLog(targetId);
  }
  const raw = JSON.parse(text) as unknown; // parse error propagates — deliberately
  const failures = validateTopicLog(raw);
  if (failures.length) {
    throw new Error(`targets/${targetId}/topic-log.json failed validation: ${failures.slice(0, 3).join('; ')}`);
  }
  return raw as TopicLog;
}

/** Atomic publish: tmp + fsync + rename (the #17 prescription). */
export function saveTopicLog(repoRoot: string, log: TopicLog): void {
  const file = logFile(repoRoot, log.target_id);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, JSON.stringify(log, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** The one call the two record sites make. Rows with no topics are not
 *  recorded — an empty annotation is not an outcome. */
export function recordTopicLogRow(repoRoot: string, targetId: string, row: TopicLogRow): void {
  if (row.topics.length === 0) return;
  saveTopicLog(repoRoot, upsertRow(loadTopicLog(repoRoot, targetId), row));
}

export interface TopicRollup {
  id: string;
  label: string;
  exercised: number;
  solved: number;
}

/** Derived, never stored: per-topic exercised/solved over the plan's frozen
 *  list. Topics outside the list (a vocabulary edit mid-season) are ignored —
 *  the list is the ruler. */
export function rollupTopics(topics: ConceptTopic[], log: TopicLog): TopicRollup[] {
  return topics.map((t) => {
    const rows = log.rows.filter((r) => r.topics.includes(t.id));
    return {
      id: t.id,
      label: t.label,
      exercised: rows.length,
      solved: rows.filter((r) => r.solved === true).length,
    };
  });
}
