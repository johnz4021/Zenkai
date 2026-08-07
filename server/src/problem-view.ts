/**
 * Problem view — what the interviewer knows about the CODE, bounded.
 *
 *   session start ──► codebaseViewOf() ──► repo map + failing-test snippet
 *                                          (stable half, cached)
 *   each turn ─────► focusViewOf(events) ─► the file under their eyes
 *                                          (per-turn half)
 *
 * Why: the interviewer had never seen a line of the problem — asked "what
 * exception does the failure name?", it genuinely did not know. Decided
 * design is smart PUSH over tools: turns are two sentences, the trace knows
 * what the candidate is engaged with, and code selects it deterministically
 * with no agentic round trip. The binding constraint is attention, not
 * cost — hence hard char caps and outline-over-content for big files
 * (hydrator.py is 378 lines; its outline is ~20 and still lets a probe name
 * `_attempt_task`).
 *
 * Shape mirrors workspace-view.ts: pure core (renderRepoMap,
 * findFailingTest, outlineOf, currentFocus, namedOutOfContextFiles — no fs,
 * unit-tested), thin fs shell (codebaseViewOf, focusViewOf).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { TraceEvent, ViewRangePayload } from '@interview-prep/shared';
import { listWorkspaceFiles } from './panes.js';
import { isTestFile } from './validate.js';

/** Failing-test snippet budget (stable half). */
export const TEST_SNIPPET_CAP = 1_500;
/** Per-turn focused-file budget: full content under this, outline above. */
export const FOCUS_CAP = 2_000;
/** Outline budget — a file pathological enough to blow this gets truncated. */
export const OUTLINE_CAP = 1_200;
/** Lines of context around the visible window when a view_range exists. */
export const WINDOW_PAD = 20;

export interface WorkspaceFile {
  rel: string;
  content: string;
}

/** Orientation without dilution: names and sizes, never content. */
export function renderRepoMap(files: { rel: string; lines: number }[]): string {
  if (files.length === 0) return '(empty workspace)';
  return files.map((f) => `  ${f.rel} — ${f.lines} lines`).join('\n');
}

/**
 * Locate the failing test's body by name. No machinery existed for this —
 * the manifest has no test-file field and parseVitestJson discards the
 * per-file name — so this is convention-driven: take the name's last
 * segment, find it in a test file (validate.ts conventions), return the
 * enclosing block. Null when nothing matches; callers fall back to the
 * test file's head rather than guessing.
 */
export function findFailingTest(
  files: WorkspaceFile[],
  failingTest: string,
): { rel: string; snippet: string } | null {
  const name = testNameSegment(failingTest);
  if (!name) return null;
  for (const f of files) {
    if (!isTestFile(f.rel)) continue;
    const lines = f.content.split('\n');
    const hit = lines.findIndex((l) => l.includes(name));
    if (hit === -1) continue;
    return { rel: f.rel, snippet: enclosingBlock(lines, hit) };
  }
  return null;
}

/** Last segment of a unittest ("tests.mod.Class.test_x") or vitest
 *  ("suite > does the thing") test name. Vitest titles may contain dots, so
 *  '>' splits first and '.' only applies to dotted-identifier shapes. */
export function testNameSegment(failingTest: string): string {
  const afterArrow = failingTest.split('>').pop()?.trim() ?? '';
  if (/^[A-Za-z_][\w.]*$/.test(afterArrow)) {
    return afterArrow.split('.').pop() ?? afterArrow;
  }
  return afterArrow;
}

/** The declaration block around line `hit`: back to the enclosing
 *  def/it/test line, forward to the next same-or-outer-indent declaration. */
function enclosingBlock(lines: string[], hit: number): string {
  const DECL = /^\s*(async\s+def\s|def\s|it\(|it\.\w+\(|test\(|test\.\w+\()/;
  let start = hit;
  while (start > 0 && !DECL.test(lines[start] ?? '')) start--;
  const indent = (lines[start] ?? '').match(/^\s*/)?.[0].length ?? 0;
  const OUTER = /^\s*(async\s+def\s|def\s|class\s|it\(|it\.\w+\(|test\(|test\.\w+\(|describe\()/;
  let end = hit + 1;
  while (end < lines.length) {
    const l = lines[end] ?? '';
    const lIndent = l.match(/^\s*/)?.[0].length ?? 0;
    // Stops: the next declaration at the same level, or a dedent OUT of the
    // enclosing scope (the last test in a python class must not drag the
    // module's `if __name__` tail along).
    if (l.trim() !== '' && (lIndent < indent || (lIndent === indent && OUTER.test(l)))) break;
    end++;
  }
  const body = lines.slice(start, end).join('\n').trimEnd();
  return body.length > TEST_SNIPPET_CAP
    ? body.slice(0, TEST_SNIPPET_CAP) + '\n…(snippet truncated)'
    : body;
}

/** Structural outline: declaration lines with their line numbers. The probe
 *  fuel for files too big to push whole. */
export function outlineOf(content: string): string {
  const DECL =
    /^\s*(async\s+def\s|def\s|class\s|export\s|function\s|async\s+function\s|const\s+\w+\s*=|describe\(|it\(|test\()/;
  const out: string[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (DECL.test(l)) out.push(`  ${i + 1}: ${l.trim().slice(0, 90)}`);
  }
  const body = out.join('\n');
  if (!body) return '(no recognizable declarations)';
  return body.length > OUTLINE_CAP ? body.slice(0, OUTLINE_CAP) + '\n…(outline truncated)' : body;
}

/**
 * Where the candidate's attention is, from the trace: the newest file_open
 * (which, since the focus sensor, includes tab switches) plus the newest
 * view_range for that file. Pure; paths come back raw — the fs shell maps
 * container paths.
 */
export function currentFocus(
  events: TraceEvent[],
  nowMs: number,
): { path: string; dwellMs: number; range: { start: number; end: number } | null } | null {
  let focus: { path: string; ts: number } | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'file_open') continue;
    const p = String((e.payload as { path?: string })?.path ?? '');
    if (!p) continue;
    focus = { path: p, ts: e.ts };
    break;
  }
  if (!focus) return null;
  let range: { start: number; end: number } | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'view_range') continue;
    const p = e.payload as ViewRangePayload | null;
    if (String(p?.path ?? '') !== focus.path) continue;
    if (typeof p?.start === 'number' && typeof p?.end === 'number') {
      range = { start: p.start, end: p.end };
    }
    break;
  }
  return { path: focus.path, dwellMs: Math.max(0, nowMs - focus.ts), range };
}

/** The per-turn focused-file block from pre-read content. Pure. */
export function renderFocus(
  rel: string,
  content: string,
  dwellMs: number,
  range: { start: number; end: number } | null,
): string {
  const dwellMin = Math.round(dwellMs / 60_000);
  const dwell = dwellMin >= 1 ? ` (for ~${dwellMin} min)` : '';
  const header = `── currently viewing: ${rel}${dwell}`;
  if (content.length <= FOCUS_CAP) return `${header}\n${content.trimEnd()}`;
  // Too big to push whole. Prefer the lines actually on their screen —
  // that is what a human looking over a shoulder sees — else the outline.
  if (range) {
    const lines = content.split('\n');
    const from = Math.max(0, range.start - 1 - WINDOW_PAD);
    const to = Math.min(lines.length, range.end + WINDOW_PAD);
    const windowText = lines
      .slice(from, to)
      .map((l, i) => `${from + i + 1}: ${l}`)
      .join('\n');
    if (windowText.length <= FOCUS_CAP) {
      return `${header}\n(on their screen: lines ${range.start}–${range.end}, shown with context)\n${windowText}`;
    }
  }
  return `${header}\n(${content.split('\n').length} lines — structural outline)\n${outlineOf(content)}`;
}

/**
 * read_file instrumentation (the deferred-tool question, decided by data):
 * which workspace files did this utterance name whose CONTENT the
 * interviewer does not have? Logged per turn; if it fires often on
 * multi-file rounds the tool has earned its latency, if never we saved an
 * agentic loop. Matches basename or (length>3) stem on a word boundary —
 * voice transcripts rarely render ".py".
 */
export function namedOutOfContextFiles(
  message: string,
  allFiles: string[],
  inContextFiles: string[],
): string[] {
  const baseOf = (f: string) => f.split('/').pop() ?? f;
  const stemOf = (b: string) => b.replace(/\.[^.]+$/, '');
  const inContext = new Set(inContextFiles.map(baseOf));
  // A stem shared with an in-context file resolves to that file: saying
  // "hydrator" while viewing hydrator.py must not flag docs/hydrator.md.
  const inContextStems = new Set([...inContext].map(stemOf));
  const out: string[] = [];
  for (const rel of allFiles) {
    const base = baseOf(rel);
    if (inContext.has(base)) continue;
    const stem = stemOf(base);
    const hay = message.toLowerCase();
    const named =
      hay.includes(base.toLowerCase()) ||
      (stem.length > 3 &&
        !inContextStems.has(stem) &&
        new RegExp(`\\b${escapeRe(stem)}\\b`, 'i').test(message));
    if (named) out.push(base);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- fs shell ----

const SKIP_CONTENT = new Set(['problem.json', 'PROBLEM.md', 'package-lock.json']);

function readWorkspace(problemDir: string): WorkspaceFile[] {
  return listWorkspaceFiles(problemDir)
    .filter((rel) => !SKIP_CONTENT.has(path.basename(rel)))
    .map((rel) => {
      try {
        return { rel, content: readFileSync(path.join(problemDir, rel), 'utf8') };
      } catch {
        return null;
      }
    })
    .filter((f): f is WorkspaceFile => f !== null);
}

/**
 * The stable half: repo map + the failing test verbatim. Computed ONCE at
 * session start (it describes the problem as handed out, not the work) so
 * the cached system block stays byte-identical across turns.
 */
export function codebaseViewOf(problemDir: string, failingTest: string | null): string {
  const files = readWorkspace(problemDir);
  const map = renderRepoMap(files.map((f) => ({ rel: f.rel, lines: f.content.split('\n').length })));
  const sections = [`Files in the workspace:\n${map}`];
  if (failingTest) {
    const found = findFailingTest(files, failingTest);
    if (found) {
      sections.push(`The failing test, verbatim (from ${found.rel}):\n${found.snippet}`);
    } else {
      const testFile = files.find((f) => isTestFile(f.rel));
      if (testFile) {
        sections.push(
          `Could not locate "${failingTest}" by name — head of ${testFile.rel} instead:\n` +
            testFile.content.slice(0, TEST_SNIPPET_CAP),
        );
      }
    }
  }
  return sections.join('\n\n');
}

/** Container-absolute → problem-relative (same mapping workspace-view.ts
 *  uses); panes events already carry relative paths. Exported for the
 *  in-context bookkeeping in session.ts. */
export function toRel(p: string): string | null {
  const m = p.match(/^\/home\/workspace\/[^/]+\/(.+)$/);
  if (m) return m[1]!;
  if (!path.isAbsolute(p)) return p;
  return null;
}

/** The per-turn focused-file block, or '' when no file has focus yet. */
export function focusViewOf(problemDir: string, events: TraceEvent[], nowMs: number): string {
  const focus = currentFocus(events, nowMs);
  if (!focus) return '';
  const rel = toRel(focus.path);
  if (!rel || path.basename(rel) === 'problem.json') return '';
  // The statement opens as a preview at session start — its text is already
  // the {{SPEC}} slot; pushing it again would only dilute.
  if (path.basename(rel) === 'PROBLEM.md') {
    return '── currently viewing: PROBLEM.md (the problem statement — already in your context above)';
  }
  let content: string;
  try {
    content = readFileSync(path.join(problemDir, rel), 'utf8');
  } catch {
    return '';
  }
  return renderFocus(rel, content, focus.dwellMs, focus.range);
}
