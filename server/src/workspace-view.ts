/**
 * Workspace view — the interviewer's eyes.
 *
 *   session start ──► snapshotWorkspace() ──► <problemDir>/.session-snapshot/
 *                                                      │
 *   each turn ──► renderWorkspaceView(events) ──► diffs of recently-edited
 *                                                 files + latest test output
 *
 * Why (sess-1785962737985 + the rubric-blind finding): the interviewer's
 * entire view of the candidate's work was "-42s edit file A · test run
 * FAILED" — aliased letters and booleans. It had never seen a line of their
 * code or a word of a failure, so every probe was generic by construction.
 * The problem dir is a host bind mount; the eyes were always one readFile
 * away.
 *
 * Shape: pure core (diffLines, selectRecentlyEdited, assembleView — no fs,
 * unit-tested), thin fs shell (snapshotWorkspace, renderWorkspaceView).
 * Caps are load-bearing: the view is per-turn FRESH prompt input, so it is
 * bounded (~3k chars) by construction, and a mega-rewrite degrades to a
 * count line, never a mega-diff.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { TraceEvent, TestRunPayload } from '@interview-prep/shared';
import { listWorkspaceFiles } from './panes.js';

export const SNAPSHOT_DIR = '.session-snapshot';
/** Total budget for the whole view — fresh tokens every turn. */
export const VIEW_CAP = 3_000;
/** Per-file diff budget. */
export const FILE_DIFF_CAP = 1_200;
/** How many recently-edited files get a diff. */
export const MAX_DIFF_FILES = 3;
/** Test-output tail budget inside the view. */
export const TAIL_CAP = 900;

/** Session-start baseline. Overwrites any prior snapshot — a rebuilt or
 *  re-run problem must never diff against a stale baseline. */
export function snapshotWorkspace(problemDir: string): void {
  const dest = path.join(problemDir, SNAPSHOT_DIR);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const rel of listWorkspaceFiles(problemDir)) {
    const to = path.join(dest, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    try {
      cpSync(path.join(problemDir, rel), to);
    } catch {
      /* file vanished mid-walk — the diff will show it as new/removed */
    }
  }
}

/**
 * Minimal line diff: common prefix/suffix anchoring. Not an LCS — for the
 * edit shapes a 45-minute session produces (localized changes), anchoring
 * gives readable hunks at a fraction of the code. A heavy rewrite blows the
 * cap and degrades to a summary line, which is the honest rendering anyway.
 */
export function diffLines(before: string, after: string, cap = FILE_DIFF_CAP): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const body = [
    `@ line ${start + 1}`,
    ...removed.map((l) => `- ${l}`),
    ...added.map((l) => `+ ${l}`),
  ].join('\n');
  if (body.length > cap) {
    return `@ line ${start + 1} (heavily rewritten: -${removed.length}/+${added.length} lines — diff too large to show)`;
  }
  return body;
}

/** Relative paths of files with edit/file_save events, most recent first,
 *  deduped. Pure. Paths in events may be absolute container paths — the
 *  caller maps them; here we just order them. */
export function selectRecentlyEdited(events: TraceEvent[], max = MAX_DIFF_FILES): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < max; i--) {
    const e = events[i]!;
    if (e.type !== 'edit' && e.type !== 'file_save') continue;
    const p = String((e.payload as { path?: string })?.path ?? '');
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** The latest completed test run's summary + tail, or null. Pure. */
export function latestRunView(events: TraceEvent[]): { summary: string; tail: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'test_run') continue;
    const p = e.payload as TestRunPayload | null;
    if (p?.exit_code === null || p?.exit_code === undefined) continue;
    return {
      summary: String(p.summary ?? (p.exit_code === 0 ? 'PASSED' : 'FAILED')),
      tail: String(p.output_tail ?? '').slice(-TAIL_CAP),
    };
  }
  return null;
}

/** Assemble the prompt block from pre-read contents. Pure — the fs shell
 *  below feeds it. */
export function assembleView(
  parts: { relPath: string; before: string | null; after: string | null }[],
  run: { summary: string; tail: string } | null,
): string {
  const sections: string[] = [];
  for (const { relPath, before, after } of parts) {
    if (after === null) {
      sections.push(`── ${relPath} (deleted this session)`);
      continue;
    }
    if (before === null) {
      sections.push(`── ${relPath} (NEW this session, ${after.split('\n').length} lines)`);
      continue;
    }
    const d = diffLines(before, after);
    if (d) sections.push(`── ${relPath} (their changes this session)\n${d}`);
  }
  if (run) {
    sections.push(
      `── latest test run: ${run.summary}${run.tail ? `\n${run.tail}` : ''}`,
    );
  }
  if (sections.length === 0) return '(no edits yet this session)';
  const out = sections.join('\n\n');
  return out.length > VIEW_CAP ? out.slice(0, VIEW_CAP) + '\n…(view truncated)' : out;
}

/**
 * The fs shell: map event paths (container-absolute, "/home/workspace/
 * p-<sid>/<rel>") back to problem-dir-relative, read current + snapshot
 * copies of the few selected files, and assemble. Cheap per turn: at most
 * MAX_DIFF_FILES pairs of reads.
 */
export function renderWorkspaceView(problemDir: string, events: TraceEvent[]): string {
  const toRel = (p: string): string | null => {
    // Container path: /home/workspace/p-<sid>/rel — strip through the
    // workspace root. Panes events already carry problem-relative paths.
    const m = p.match(/^\/home\/workspace\/[^/]+\/(.+)$/);
    if (m) return m[1]!;
    if (!path.isAbsolute(p)) return p;
    return null;
  };
  const read = (abs: string): string | null => {
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
  const parts = selectRecentlyEdited(events)
    .map((raw) => {
      const rel = toRel(raw);
      if (!rel || rel.startsWith(SNAPSHOT_DIR)) return null;
      return {
        relPath: rel,
        before: read(path.join(problemDir, SNAPSHOT_DIR, rel)),
        after: read(path.join(problemDir, rel)),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return assembleView(parts, latestRunView(events));
}

/** Does the snapshot exist (session actually started through runSession)? */
export function hasSnapshot(problemDir: string): boolean {
  return existsSync(path.join(problemDir, SNAPSHOT_DIR));
}
