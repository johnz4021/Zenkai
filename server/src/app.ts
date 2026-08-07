/**
 * The home app — the persistent surface that exists when no session does.
 *
 *   :3300  targets · intake · per-target queues · launch
 *   :3200  session (spawned per round, owns its own lifecycle)
 *   :3100  IDE container (owned by the session process)
 *
 * The app holds NO authoritative state in memory: every /api/state call
 * reconciles queue statuses from disk (.validated, .used, assessments/) and
 * saves what changed. Killing and restarting the app is always safe — the
 * worst case is a stale page until the next poll.
 *
 * Sessions are separate processes on purpose: a session crash cannot take
 * the app down, and the session keeps sole ownership of the container and
 * port 3200 (assertPortFree guards the double-launch case).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRoundSpec, type GeneratedProblem, type RoundSpec } from '@interview-prep/shared';
import { ATTACHMENT_MEDIA_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, listTargets, loadTarget, pickSpecInferrer, saveTarget, slugify, targetDir, type SpecDraft, type Target } from './intake.js';
import { bucketIntoDays, loadQueue, nextUp, proposeQueue, reconcileWithDisk, repace, saveQueue, type Queue, type QueueItem } from './queue.js';
import { buildGraphView, gapDescription, loadStore } from './gap-graph.js';
import { applyAdaptation, pickAdapter, planAdaptation, reconcileAdaptation, retiredSpecIds, type AdaptDiff } from './adapt.js';
import { appendLearnings, gateBlueprint, loadBlueprint, writeBlueprintWithBackup } from './blueprint.js';
import { clearGeneratingMarker, generationProgress, pidAlive, readGeneratingMarker, sweepVerdict, writeGeneratingMarker } from './generation-state.js';
import { pickTopicNamer } from './plan-topics.js';
import { clientScript } from './chrome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export interface AppConfig {
  port: number;
  sessionPort: number;
  userId: string;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => resolve(body));
  });
}

/** Probe the session server. `reachable` = something answered on the port;
 *  `live` = answered AND not ended. The distinction is ISSUE-001's fix: a
 *  graded session's server lingers to keep serving the card, and treating
 *  its 200 as "live" soft-locked every future launch. Probed, never
 *  remembered. */
function probeSession(port: number): Promise<{ reachable: boolean; ended: boolean }> {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1_000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { ended?: boolean };
          resolve({ reachable: res.statusCode === 200, ended: Boolean(parsed.ended) });
        } catch {
          resolve({ reachable: res.statusCode === 200, ended: false });
        }
      });
    });
    r.on('error', () => resolve({ reachable: false, ended: false }));
    r.on('timeout', () => {
      r.destroy();
      resolve({ reachable: false, ended: false });
    });
  });
}

/** Is a session actually running (not a lingering graded server)? */
async function sessionLive(port: number): Promise<boolean> {
  const p = await probeSession(port);
  return p.reachable && !p.ended;
}

/** POST to the session server; ok=false on any failure. */
function postSession(port: number, apiPath: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: apiPath, method: 'POST', timeout: 5_000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: (res.statusCode ?? 500) < 300 }));
      },
    );
    r.on('error', () => resolve({ ok: false }));
    r.on('timeout', () => {
      r.destroy();
      resolve({ ok: false });
    });
    r.end();
  });
}

/** Problem dirs with a generation child alive in THIS app process. Used
 *  only to tell "in progress" from "orphaned" — all authoritative state
 *  stays on disk (.validated / .failed markers). */
const liveGenerations = new Set<string>();

/** The soonest date any of this target's rounds happens — spec dates first,
 *  the target's single date as fallback. Drives index ordering. */
function nearestDeadline(t: {
  interview_date?: string | null;
  specs: { date?: string | null }[];
}): string | undefined {
  let min: string | undefined;
  for (const s of t.specs) {
    const d = s.date ?? t.interview_date;
    if (d && (!min || d < min)) min = d;
  }
  return min ?? t.interview_date ?? undefined;
}

function spawnDetached(args: string[], env: Record<string, string> = {}): void {
  const child = spawn('npx', ['tsx', path.join(repoRoot, 'server', 'src', 'cli.ts'), ...args], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
}

/** Generation spawn with failure bookkeeping: a non-zero exit writes a
 *  .failed marker into the item dir so reconcile derives `failed` and the
 *  timeline can offer retry — a silent stuck "generating" row was the
 *  design review's exact never-silent rule. */
function spawnGeneration(target: Target, item: QueueItem, dir: string): void {
  const args = ['generate-for', target.id, item.spec_id, '--into', dir];
  if (item.planned_title) args.push('--title', item.planned_title);
  liveGenerations.add(dir);
  mkdirSync(dir, { recursive: true });
  const child = spawn('npx', ['tsx', path.join(repoRoot, 'server', 'src', 'cli.ts'), ...args], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  // Disk-derived liveness (ISSUE-003): the marker carries {pid, started_at}
  // so an app restart can tell a healthy detached generation from a true
  // orphan — and the UI gets an honest start time.
  if (child.pid) writeGeneratingMarker(dir, child.pid);
  child.on('close', (code) => {
    liveGenerations.delete(dir);
    clearGeneratingMarker(dir);
    if (code !== 0 && !existsSync(path.join(dir, '.validated'))) {
      writeFileSync(path.join(dir, '.failed'), `exit ${code} at ${new Date().toISOString()}\n`);
      console.warn(`[app] generation failed for ${item.id} (exit ${code})`);
    }
  });
}

/** App restart while a generation was mid-flight: probe the marker's pid
 *  before judging (ISSUE-003 — the old sweep trusted an in-memory Set that
 *  restarts empty, and marked HEALTHY generations failed while their agent
 *  kept writing; a retry click then would have double-generated into the
 *  same directory). Liveness is injectable for tests. */
function sweepOrphanedGenerations(isAlive: (pid: number) => boolean = pidAlive): void {
  for (const t of listTargets(repoRoot)) {
    const q = loadQueue(repoRoot, t.id);
    if (!q) continue;
    for (const item of q.items) {
      if (item.status !== 'generating' || !item.problem_dir) continue;
      const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
      if (liveGenerations.has(dir)) continue;
      const marker = readGeneratingMarker(dir);
      const verdict = sweepVerdict({
        marker,
        alive: marker ? isAlive(marker.pid) : false,
        hasTerminalMarker:
          existsSync(path.join(dir, '.validated')) || existsSync(path.join(dir, '.failed')),
      });
      if (verdict === 'clear-marker') {
        clearGeneratingMarker(dir);
      } else if (verdict === 'fail') {
        clearGeneratingMarker(dir);
        writeFileSync(path.join(dir, '.failed'), `orphaned by app restart at ${new Date().toISOString()}\n`);
        console.warn(`[app] ${t.id}/${item.id} orphaned by restart — marked failed (retryable)`);
      } else {
        console.log(`[app] ${t.id}/${item.id} still generating (pid ${marker!.pid} alive) — left alone`);
      }
    }
  }
}

/** Display title for an item: the generated problem's own name wins, the
 *  planned title promises it, the spec's first sentence is the legacy
 *  fallback. Never the "label — round N" string (the twelve-identical-rows
 *  bug the redesign exists to kill). */
function resolveTitle(item: QueueItem): string | null {
  if (item.problem_dir) {
    const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
    const manifest = path.join(dir, 'problem.json');
    if (existsSync(manifest)) {
      try {
        const p = JSON.parse(readFileSync(manifest, 'utf8')) as GeneratedProblem;
        if (p.title) return p.title;
        const sentence = p.spec?.split(/[.!?]/)[0]?.trim();
        if (sentence) return sentence.length > 60 ? `${sentence.slice(0, 57)}…` : sentence;
      } catch {
        /* half-written manifest mid-generation */
      }
    }
  }
  return item.planned_title ?? null;
}

/** Reconcile a target's queue with disk, re-pace, persist if changed, and
 *  auto-kick generation for the next pending item when nothing is in
 *  flight — the queue-driven successor of prepareNext. */
function refreshQueue(target: Target, userId: string, now: number): Queue | null {
  const stored = loadQueue(repoRoot, target.id);
  if (!stored) return null;
  const view = (() => {
    try {
      return buildGraphView(loadStore(path.join(repoRoot, 'gaps'), userId));
    } catch {
      return null;
    }
  })();
  // Crash repair first (D3): an adapt writes target.json before
  // queue.json, so a death between the writes leaves the record ahead of
  // the queue — re-apply the recorded re-points before anything renders.
  const healed = reconcileAdaptation(target, stored) ?? stored;
  const fresh = repace(reconcileWithDisk(repoRoot, healed), target, view, now);

  // Generation is USER-INITIATED (user decision 2026-08-01: no auto-kick).
  // The app never spends a generation the candidate didn't ask for —
  // /api/generate is the only path in. This also caps the unmetered-spend
  // exposure TODOS #12 describes.
  if (JSON.stringify(fresh) !== JSON.stringify(stored)) saveQueue(repoRoot, fresh);
  return fresh;
}

/**
 * The page (design review 2026-07-31, approved mockups firstrun-E-attach +
 * variant-C/A). Two sections, client-toggled: #entry — the first-run screen
 * where the screen IS the input — and #seasons, the day-by-day timeline.
 * Markup here is skeleton + the entry form (real <label for> everywhere —
 * the shipped placeholder-as-label pattern was a hard-rule violation);
 * everything stateful renders client-side from /api/state.
 */
export function appPage(): string {
  return /* html */ `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Zenkai</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64' fill='none'%3E%3Crect width='64' height='64' fill='%230e0e0f'/%3E%3Ccircle cx='32' cy='32' r='24' stroke='%230088b0' stroke-width='8' stroke-dasharray='118 33'/%3E%3Cpath d='M18 46 L52 12' stroke='%23f4f4f5' stroke-width='8'/%3E%3Cpath d='M40 12 L52 12 L52 24' stroke='%23f4f4f5' stroke-width='8' stroke-linejoin='miter'/%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    /* Graphite Steel (direction 3a). Brand plates survive at full saturation —
       the ONLY branded pixels in a monochrome shell. */
    --plate-cyan: #0088b0; --plate-mag: #d6006c;
    /* Ground: one tone-step per layer, no elevation. */
    --bg: #0e0e0f; --panel: #151517; --raised: #1d1e20; --sunk: #131314;
    --text-1: #f4f4f5; --text-2: #96979b; --text-3: #66676b;
    --line: #292a2c; --line-soft: #1c1c1e; --rule: #191919;
    /* Steel marks TIME and POSITION — never action, never grade, never identity. */
    --steel: #35708f; --steel-text: #7ea9c2;
    /* Grades: the only other saturation on screen. Shape backs up hue (■/◆/▫). */
    --ok: #5f9e7a; --weak: #e82b86; --weak-text: #ff6fae; --none: #4a4b4f;
    --mono: 'JetBrains Mono', ui-monospace, monospace;
    --rail: 93px; /* x of the timeline spine: date col 74 + gap 14 + dot half */
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    margin: 0 auto; max-width: 760px; padding: 40px 20px 64px;
    font: 14px/1.55 'Archivo', system-ui, sans-serif;
    background: var(--bg); color: var(--text-1);
    min-height: 100vh;
  }
  ::selection { background: var(--steel); color: #fff; }

  .micro { font-family: var(--mono); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .18em; color: var(--text-3); margin: 0 0 18px; }
  .meta { color: var(--text-2); }
  .err { color: var(--weak-text); }
  a { color: inherit; }
  /* ---- masthead: the one persistent chrome ---- */
  nav {
    display: flex; justify-content: space-between; align-items: center;
    gap: 16px; margin: 0 -20px 30px; padding: 0 20px 16px;
    position: sticky; top: 0; z-index: 10;
    background: var(--bg); border-bottom: 1px solid var(--line-soft);
  }
  nav a { text-decoration: none; }
  /* Lockup: mark and wordmark side by side. The plates keep full saturation —
     deliberately the only branded pixels in the graphite shell. */
  .brand { display: flex; align-items: center; gap: 13px; }
  .brand svg { display: block; overflow: visible; }
  .brand .plate-mag { stroke: var(--plate-mag); }
  .brand .plate-cyan { stroke: var(--plate-cyan); }
  .brand .vector { stroke: var(--text-1); }  /* reversed for the dark ground, per the sheet's own reversed-on-black variant */
  .brand .word {
    font-family: var(--mono); font-size: 16px; font-weight: 500;
    text-transform: uppercase; letter-spacing: .16em; line-height: 1; color: var(--text-1);
    transition: color .18s;
  }
  #nav-home:hover .word { color: #fff; }
  .navright { display: flex; align-items: center; gap: 18px; }
  #nav-live { display: none; align-items: center; gap: 7px; color: var(--steel-text); font-size: 12px; font-family: var(--mono); }
  #nav-live.on { display: flex; }
  #nav-kill { display: none; color: var(--text-2); font-size: 12px; }
  #nav-kill.on { display: inline; }
  #nav-kill:hover { color: var(--weak-text); }
  #nav-live .pulse { width: 6px; height: 6px; background: var(--steel-text); animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
  #nav-new { color: var(--text-2); font-size: 12px; transition: color .18s; }
  #nav-new:hover { color: var(--text-1); }

  /* ---- first paint: the shape of the page before data lands ---- */
  #boot { padding-top: 6px; }
  #boot .sk { height: 11px; background: var(--line-soft); margin: 16px 0; animation: breathe 1.5s ease-in-out infinite; }
  #boot .sk:nth-child(1) { width: 42%; height: 30px; }
  #boot .sk:nth-child(2) { width: 100%; animation-delay: .1s; }
  #boot .sk:nth-child(3) { width: 78%; animation-delay: .2s; }
  #boot .sk:nth-child(4) { width: 88%; animation-delay: .3s; }
  @keyframes breathe { 0%, 100% { opacity: .5; } 50% { opacity: .22; } }

  /* ---- scrollbar: part of the instrument, not the OS ---- */
  * { scrollbar-width: thin; scrollbar-color: #2a2b2e var(--bg); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: #2a2b2e; border: 3px solid var(--bg); border-radius: 5px; }
  ::-webkit-scrollbar-thumb:hover { background: #3c3d40; }

  button {
    background: none; border: 1px solid var(--line); color: var(--text-1);
    padding: 6px 14px; font: inherit; font-weight: 500; cursor: pointer; min-height: 32px;
    border-radius: 6px;
    transition: border-color .18s, background .18s;
  }
  button:hover { border-color: #3c3d40; }
  /* The action is WHITE. Steel never sits on a button — it would stop meaning time. */
  button.primary { background: var(--text-1); border-color: var(--text-1); color: var(--bg); font-weight: 600; }
  button.primary:hover { background: #fff; border-color: #fff; }
  :is(button, input, textarea, a, [tabindex]):focus-visible { outline: 2px solid var(--steel); outline-offset: 2px; }
  input, textarea {
    width: 100%; background: var(--sunk); border: 1px solid var(--line);
    color: inherit; font: inherit; padding: 9px 11px; border-radius: 6px; transition: border-color .18s;
  }
  input:hover, textarea:hover { border-color: #3c3d40; }
  input:focus, textarea:focus { border-color: var(--steel); }
  label { display: block; margin: 18px 0 5px; font-weight: 500; }
  .banner { border: 1px solid var(--steel); background: rgba(53, 112, 143, .08); padding: 10px 14px; margin: 0 0 20px; border-radius: 6px; }

  /* ---- entrance choreography: one orchestrated load per page, never on
         polls; fully off under reduced motion ---- */
  @keyframes rise { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
  .animate .runway li, .animate a.plancard, .animate .season > * { animation: rise .45s cubic-bezier(.2, .7, .2, 1) both; animation-delay: calc(var(--i, 0) * 32ms); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }

  /* ---- entry (make a plan) ---- */
  .attach { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--line-soft); }
  .attach .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach .kind { color: var(--text-2); font-size: 12px; }
  .attach button { border: 0; color: var(--text-2); padding: 0 6px; min-height: 0; }
  .attach button:hover { color: var(--text-1); }
  .findings p { margin: 7px 0; }
  .rationale { color: var(--text-2); white-space: pre-wrap; }
  .specbox { border: 1px solid var(--line); padding: 13px 15px; margin: 10px 0; background: var(--panel); border-radius: 6px; }
  .specbox.dropped { opacity: .55; }
  .specbox .keep { display: inline-flex; gap: 6px; margin-left: 12px; color: var(--text-2); font-weight: 400; }
  .specbox .keep input { width: auto; }
  .progress { height: 2px; background: var(--line); margin: 16px 0; overflow: hidden; }
  .progress .fill { height: 100%; background: var(--steel); width: 30%; animation: slide 1.5s ease-in-out infinite alternate; }
  /* Determinate variant: width measures real elapsed vs the 8-min wall. */
  .progress .fill.det { animation: none; transition: width 1s linear; }
  @keyframes slide { from { margin-left: 0; } to { margin-left: 70%; } }

  /* ---- planning surface: Cowork grammar (design D1, 2026-08-07) ----
     The chat contains NOTHING but prose; ALL structure lives in the plan
     panel, which the model maintains through its propose_rounds tool. Wide
     screens get a right rail; narrow ones stack the panel above the
     composer. body.wide widens the page column for this route only. */
  body.wide { max-width: 1180px; }
  #plan-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 28px; align-items: start; }
  /* Empty state (no conversation yet): no panel to reserve a rail for —
     single column, centered, so the intake moment isn't lopsided (QA ISSUE-001). */
  #plan-wrap.nopanel { grid-template-columns: minmax(0, 1fr); }
  #plan-wrap.nopanel #plan-main { max-width: 62ch; margin: 0 auto; width: 100%; }
  #plan-main { min-width: 0; }
  #plan-chat { max-width: 62ch; }
  .turn-user { border-left: 1px solid var(--line); padding-left: 16px; margin: 24px 0; white-space: pre-wrap; }
  .turn-user .att { color: var(--text-2); font-size: 12px; margin-top: 6px; white-space: normal; }
  .turn-planner { margin: 24px 0; }
  .turn-planner p { margin: 0 0 12px; line-height: 1.65; }
  .turn-planner a { color: var(--steel-text); text-decoration: none; border-bottom: 1px solid rgba(126, 169, 194, .4); overflow-wrap: anywhere; }
  /* Settled turns recede; the current turn is where the eye should land. */
  .turn-planner.history { opacity: .55; }
  .turn-planner.history:hover { opacity: 1; }
  /* Pasted walls collapse to chips — the candidate's own paste must never
     dominate the viewport (live-screenshot finding, 2026-08-07). */
  .pastechip { display: flex; gap: 10px; width: 100%; text-align: left; background: none; border: 0; border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); padding: 7px 0; min-height: 0; color: var(--text-2); font-size: 12px; cursor: pointer; font-family: var(--mono); }
  .pastechip:hover { color: var(--text-1); }
  .pastebody { margin: 0; padding: 4px 0 10px 20px; font-size: 13px; line-height: 1.6; color: var(--text-2); white-space: pre-wrap; }
  #plan-intro { color: var(--text-2); margin: 28px 0; line-height: 1.65; }
  /* The plan panel: the ONE structured surface. */
  #plan-panel { border: 1px solid var(--line); background: var(--panel); border-radius: 6px; position: sticky; top: 64px; display: flex; flex-direction: column; max-height: calc(100vh - 90px); }
  #plan-panel .phead { padding: 12px 16px 8px; border-bottom: 1px solid var(--line); }
  #plan-panel .phead .micro { margin: 0; }
  #plan-panel .phead .meta { font-size: 12px; margin-top: 3px; }
  #plan-panel .pbody { overflow-y: auto; min-height: 0; }
  .gaterow { border-bottom: 1px solid var(--line-soft); border-left: 2px solid transparent; padding: 10px 14px 10px 12px; }
  .gaterow.flash { animation: rowflash 1.1s ease-out; }
  @keyframes rowflash { 0% { border-left-color: transparent; } 15% { border-left-color: var(--steel); } 100% { border-left-color: transparent; } }
  @media (prefers-reduced-motion: reduce) { .gaterow.flash { animation: none; } }
  .gaterow .gcheck { display: flex; gap: 8px; align-items: baseline; margin: 0; font-weight: 500; cursor: pointer; }
  .gaterow .gcheck input { width: auto; accent-color: var(--steel); }
  .gaterow .gshape { color: var(--text-2); font-size: 12px; margin: 3px 0 0 22px; line-height: 1.5; }
  .gaterow .grow2 { display: flex; align-items: center; gap: 10px; margin: 6px 0 0 22px; }
  .gaterow .gdate { font-size: 12px; color: var(--text-2); }
  .gaterow .gdate.nodate { color: var(--text-3); }
  .tier { font: inherit; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; background: none; border: 1px solid var(--line); padding: 1px 7px; cursor: pointer; color: var(--text-2); min-height: 0; }
  .tier:hover { border-color: var(--text-3); color: var(--text-1); }
  .gaterow .gexpand { background: none; border: 0; min-height: 0; padding: 0; margin-left: auto; color: var(--text-2); font-size: 12px; cursor: pointer; white-space: nowrap; }
  .gaterow .gexpand:hover { color: var(--text-1); }
  .gatedetail { padding: 6px 0 2px 22px; color: var(--text-2); font-size: 12px; line-height: 1.6; }
  .gatedetail b { color: var(--text-1); font-weight: 500; }
  .gatedecline { color: var(--text-2); font-size: 12px; padding: 8px 14px; border-bottom: 1px solid var(--line-soft); }
  .paceline { padding: 10px 14px; font-size: 12px; line-height: 1.5; color: var(--text-2); }
  #plan-panel .pfoot { padding: 12px 14px 14px; border-top: 1px solid var(--line); }
  #plan-panel .pfoot button { width: 100%; padding: 10px; }
  #plan-panel .pfoot .meta { font-size: 12px; margin-top: 8px; display: block; line-height: 1.5; }
  #plan-composer { margin-top: 14px; position: sticky; bottom: 0; background: var(--bg); padding-bottom: 10px; max-width: 62ch; }
  #plan-composer .row { display: flex; gap: 8px; align-items: flex-start; }
  #plan-composer textarea { flex: 1; min-height: 58px; resize: none; }
  #plan-composer .helper { font-size: 12px; color: var(--text-3); margin-top: 7px; line-height: 1.5; }
  #plan-attach { margin-bottom: 6px; }
  @media (max-width: 1099px) {
    body.wide { max-width: 760px; }
    /* The base grid rule's align-items:start would leak into this flex
       context and shrink the panel to content width (QA ISSUE-004). */
    #plan-wrap { display: flex; flex-direction: column; align-items: stretch; }
    #plan-main { display: contents; }
    #plan-chat { order: 1; }
    #plan-panel { order: 2; position: sticky; bottom: 0; top: auto; max-height: 45vh; }
    /* Only ONE bottom-sticky element per stack: a sticky composer here would
       sit on top of the panel and hide the confirm button (QA ISSUE-003). */
    #plan-composer { order: 3; position: static; }
  }
  .carddel { border: 0; color: var(--text-2); font-size: 12px; padding: 0; min-height: 0; margin-top: 8px; }
  .carddel:hover { color: var(--weak-text); }

  /* ---- all plans (index) ---- */
  a.plancard {
    display: block; border: 1px solid var(--line); padding: 16px; margin: 12px 0;
    text-decoration: none; background: var(--panel); border-radius: 6px;
    transition: border-color .18s, transform .18s;
  }
  a.plancard:hover { border-color: #3c3d40; transform: translateY(-1px); }
  .plancard h2 { font-size: 16px; font-weight: 500; margin: 0 0 4px; }
  .plancard .bar { height: 2px; background: var(--line); margin: 12px 0 8px; }
  .plancard .bar .fill { height: 100%; background: var(--steel); }
  .plancard .nextline { color: var(--text-2); }
  .plancard.setup { color: var(--text-2); }
  .plancard.setup .go { color: var(--text-1); }
  .backlink { display: inline-block; color: var(--text-2); text-decoration: none; margin-bottom: 16px; transition: color .18s; }
  .backlink:hover { color: var(--text-1); }
  .addlink { color: var(--text-2); }
  .addlink:hover { color: var(--text-1); }

  /* ---- season timeline: the countdown instrument ---- */
  .season { margin-bottom: 44px; }
  .season .daysleft { font-size: 15px; font-weight: 400; line-height: 1.2; margin: 0; color: var(--text-2); }
  /* The countdown numeral: JBM light, tabular — steel's label sits beside it,
     the number itself stays white (the brightest thing on the page). */
  .season .daysleft b { font-family: var(--mono); font-size: 54px; font-weight: 300; letter-spacing: -.04em; font-variant-numeric: tabular-nums; color: var(--text-1); display: inline-block; margin-right: 6px; vertical-align: -4px; }
  .seasonbar { height: 2px; background: var(--line); margin: 16px 0 7px; position: relative; }
  .seasonbar .fill { height: 100%; background: var(--steel); transition: width .8s cubic-bezier(.2, .7, .2, 1); }
  /* Round-day milestones on the one spine — markers, never separate bars. */
  .seasonbar .tick { position: absolute; top: -3px; width: 1px; height: 8px; background: var(--text-3); }
  .debrief { margin: -12px 0 18px; }
  .debrief a { color: var(--steel-text); }
  .paceline { display: flex; justify-content: space-between; color: var(--text-2); font-family: var(--mono); font-size: 12px; margin-bottom: 26px; }

  /* adaptation: the last change + the door for new information */
  .adaptrow { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; font-size: 12px; margin: -14px 0 22px; }
  .adaptrow .addlearn { color: var(--text-2); text-decoration: none; border-bottom: 1px dotted var(--line); white-space: nowrap; }
  .adaptrow .addlearn:hover { color: var(--text-1); border-bottom-color: var(--text-3); }
  .adaptpanel { border: 1px solid var(--line); padding: 15px; margin: 0 0 24px; background: var(--panel); border-radius: 6px; }
  .adaptpanel .learnbox { width: 100%; min-height: 96px; resize: vertical; }
  .adaptpanel .btnrow { margin-top: 12px; }
  .adaptpanel .adaptsum { font-weight: 500; margin-bottom: 10px; }
  /* Judged feedback, re-readable from the plan. Grade grammar = color AND
     shape (■ strong · ◆ weak · ▫ not-shown + hatch) so no pair of grades
     ever rests on hue alone. */
  .fbtoggle { color: var(--text-2); margin-left: 10px; font-size: 12px; }
  .fbtoggle:hover { color: inherit; }
  .fbcard { display: block; margin: 10px 0 4px; padding: 4px 14px 10px; border: 1px solid var(--line); border-radius: 6px; font-weight: 400; }
  .fbcard .desc { margin: 8px 0 4px; }
  .fbcard .fbrow { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .fbcard .fbrow:last-child { border-bottom: 0; }
  .fbcard .dim { font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
  .fbcard .fbrow .dim::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 7px; border: 1px solid var(--none); vertical-align: 0; }
  .fbcard .v-strong .dim { color: var(--ok); }
  .fbcard .v-strong .dim::before { background: var(--ok); border-color: var(--ok); }
  .fbcard .v-weak .dim { color: var(--weak-text); }
  .fbcard .v-weak .dim::before { background: var(--weak); border-color: var(--weak); transform: rotate(45deg) scale(.9); }
  .fbcard .v-none { opacity: .55; background: repeating-linear-gradient(45deg, transparent 0 5px, rgba(255, 255, 255, .03) 5px 10px); }
  .fbcard .cite { color: var(--text-2); font-size: 12px; margin: 3px 0 3px 14px; }
  .fbcard .clk { color: inherit; opacity: .9; }
  .fbcard .closedmark { border-left: 2px solid var(--steel); padding-left: 10px; }
  .fbcard .fbfocus { border: 1px solid var(--steel); padding: 8px 10px; margin-top: 10px; border-radius: 6px; }
  .fbcard .fbfocus .k { color: var(--steel-text); font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; margin: 0 0 4px; }
  .adaptpanel .bpchange summary { cursor: pointer; margin: 6px 0; }
  .adaptpanel .bpview { max-height: 260px; overflow: auto; border: 1px solid var(--line); padding: 10px 12px; font-size: 12px; white-space: pre-wrap; }
  .adaptpanel .repoint b { color: var(--text-1); }
  .stale { color: var(--weak-text); }
  .genclock { font-family: var(--mono); font-size: 11px; color: var(--text-3); }

  ol.runway { list-style: none; margin: 0; padding: 0; position: relative; }
  /* The spine: one continuous rail the whole season hangs from. */
  ol.runway::before { content: ''; position: absolute; left: var(--rail); top: 10px; bottom: 10px; width: 1px; background: var(--line); }
  .runway li { display: flex; gap: 14px; border-top: 1px solid var(--line-soft); padding: 9px 0; align-items: baseline; position: relative; }
  .runway li:first-child { border-top: 0; }
  .runway .date { width: 74px; flex: none; color: var(--text-2); font-family: var(--mono); font-size: 11px; font-weight: 400; text-transform: uppercase; letter-spacing: .08em; font-variant-numeric: tabular-nums; }
  /* Rail marks are SQUARES (3a mark grammar); the one diamond belongs to the interview. */
  .runway .dot { flex: none; width: 11px; height: 11px; border: 1.5px solid var(--line); background: var(--bg); align-self: center; z-index: 1; position: relative; left: -1px; }
  .runway .body { flex: 1; min-width: 0; }
  .runway li.past { opacity: .5; }
  .runway li.past .dot.done { border-color: var(--ok); background: var(--ok); }
  .runway li.past .body .ok { color: var(--ok); margin-right: 6px; }
  .runway li.empty .body { color: var(--text-2); }
  .runway li.today { padding: 18px 0; opacity: 1; border-top-color: var(--line); }
  .runway li.today .date { color: var(--steel-text); }
  /* Today is the brightest mark on the rail — white, outranking even the
     interview's steel diamond. Steel says where the terminus is; white says
     where YOU are. */
  .runway li.today .dot { border-color: var(--text-1); background: var(--text-1); }
  .runway li.today .title { font-size: 16px; font-weight: 500; }
  .runway .metaline { color: var(--text-2); margin-top: 3px; font-size: 12px; }
  .runway .aimed { color: var(--weak-text); margin-top: 6px; font-style: italic; }  /* the gap is the attention axis */
  .runway li.today .body { display: flex; gap: 16px; align-items: center; }
  .runway li.today .grow { flex: 1; min-width: 0; }
  .runway li.today button.primary { min-width: 96px; min-height: 44px; }
  .runway li.future { color: var(--text-2); }
  .runway li.future.empty { padding: 5px 0; }
  .runway li.quiet { padding: 4px 0; border-top: 1px solid var(--line-soft); }
  .runway li.quiet .body { color: var(--text-3); font-family: var(--mono); font-size: 11px; letter-spacing: .08em; }
  .runway li.past.donetoday { opacity: .78; }
  .runway li.past.donetoday .date { color: var(--ok); }
  .runway li.today.complete .date { color: var(--ok); }
  .runway li.today.complete .dot { border-color: var(--ok); background: var(--ok); }
  .runway button.mini { background: none; border: 1px solid var(--line); color: var(--text-2); padding: 2px 9px; font: inherit; font-size: 11px; cursor: pointer; margin-left: 10px; border-radius: 6px; }
  .runway button.mini:hover { color: var(--text-1); border-color: #3c3d40; }
  .runway li.future.empty .dot { width: 5px; height: 5px; border-width: 1px; left: 2px; }
  .runway li.collapsed .body { color: var(--text-2); }
  .runway li.collapsed .dot { border-style: dashed; background: transparent; }
  .runway li.interview { padding: 16px 0; color: var(--text-1); border-top: 1px solid var(--line); }
  .runway li.interview .date { color: var(--steel-text); }
  .runway li.interview .dot { border-color: var(--steel); background: var(--steel); transform: rotate(45deg); }
  .runway li.interview .body { font-weight: 500; letter-spacing: .02em; }

  /* ---- desktop only (design decision D7: stated, not broken) ---- */
  #narrow { display: none; }
  @media (max-width: 700px) {
    #narrow { display: block; padding: 40vh 24px 0; text-align: left; }
    #page { display: none; }
  }
</style>
<div id="narrow">
  <p class="micro">Zenkai</p>
  <p>This runs practice sessions in a real code editor, so it lives on your laptop. Open it there.</p>
</div>
<div id="page">
  <nav>
    <a href="#/" id="nav-home" class="brand" aria-label="Zenkai — all plans">
      <svg width="32" height="32" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <circle class="plate-mag" cx="32" cy="32" r="24" stroke-width="5" stroke-dasharray="118 33" transform="translate(3.4 2.8)" />
        <circle class="plate-cyan" cx="32" cy="32" r="24" stroke-width="5" stroke-dasharray="118 33" />
        <path class="vector" d="M18 46 L52 12" stroke-width="5" />
        <path class="vector" d="M40 12 L52 12 L52 24" stroke-width="5" stroke-linejoin="miter" />
      </svg>
      <span class="word">Zenkai</span>
    </a>
    <span class="navright">
      <a href="#/t/" id="nav-live" aria-live="polite"><span class="pulse"></span>session live</a>
      <a href="#" id="nav-kill" title="end the running session without grading">end session</a>
      <a href="#/new" id="nav-new">+ new plan</a>
    </span>
  </nav>
  <div id="banner" aria-live="polite"></div>
  <div id="boot"><div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>

  <section id="index" hidden></section>

  <section id="entry" hidden>
    <!-- Cowork grammar (design D1, 2026-08-07): the chat contains nothing
         but prose; ALL structure lives in the plan panel. The client renders
         the whole surface — composer, chat, panel — into entry-flow. -->
    <div id="entry-flow" aria-live="polite"></div>
    <input id="e-file" type="file" multiple hidden aria-hidden="true" />
  </section>

  <section id="timeline" hidden></section>
</div>
<script src="/client/app.js"></script>
`;
}

export function runApp(cfg: AppConfig): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(appPage());
      }
      if (url.startsWith('/client/')) {
        const body = clientScript(path.basename(url));
        if (body === null) {
          res.writeHead(404);
          return res.end('no such client file');
        }
        // no-store: the client is served from source with no build step or
        // content hash, so a cached copy silently outlives a code change and
        // meets payloads it cannot parse (found in QA — a stale app.js threw
        // on a new row kind and reported itself as a dead server).
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        return res.end(body);
      }
      if (url.startsWith('/api/feedback') && req.method === 'GET') {
        // A finished round's judged card, read from the file finalize (and
        // rejudge --record) writes. The planning page is where feedback
        // LIVES after a session — the session server that first rendered
        // the card is torn down long before anyone wants to re-read it.
        const sid = new URL(url, 'http://x').searchParams.get('session') ?? '';
        if (!/^sess-[\w-]+$/.test(sid)) return json(400, { error: 'bad session id' });
        try {
          const fb = JSON.parse(
            readFileSync(path.join(repoRoot, 'feedback', `${sid}.json`), 'utf8'),
          ) as { card?: unknown };
          if (!fb.card) return json(404, { error: 'no card for this session' });
          return json(200, { card: fb.card });
        } catch {
          return json(404, { error: 'no feedback recorded for this session' });
        }
      }
      if (url === '/api/state') {
        const now = Date.now();
        const live = await sessionLive(cfg.sessionPort);
        // The candidate's active gap, as a sentence — TODAY's "aimed at:"
        // line. The raw key ("clarify") explained nothing on the old page.
        const focus = (() => {
          try {
            const view = buildGraphView(loadStore(path.join(repoRoot, 'gaps'), cfg.userId));
            return view.focus ? { key: view.focus, description: gapDescription(view.focus) } : null;
          } catch {
            return null;
          }
        })();
        const targets = listTargets(repoRoot)
          .map((t) => {
            const queue = refreshQueue(t, cfg.userId, now);
            const withTitles = queue
              ? {
                  ...queue,
                  items: queue.items.map((i) => {
                    const dir =
                      i.status === 'generating' && i.problem_dir
                        ? path.isAbsolute(i.problem_dir)
                          ? i.problem_dir
                          : path.join(repoRoot, i.problem_dir)
                        : null;
                    return {
                      ...i,
                      title: resolveTitle(i),
                      // Honest progress (ISSUE-007): start time from the
                      // .generating marker, live file count, and a phase —
                      // replaces the decorative infinite bar.
                      ...(dir ? { generating: generationProgress(dir) } : {}),
                    };
                  }),
                }
              : null;
            return {
              target: {
                id: t.id,
                label: t.label,
                interview_date: t.interview_date ?? null,
                specs: t.specs.map((s) => ({ id: s.id, label: s.label, capabilities: s.capabilities, date: s.date ?? null, evidence_tier: s.evidence_tier ?? null })),
              },
              queue: withTitles,
              // Latest adaptation only — the timeline explains why rounds
              // changed with one line, not the whole history.
              adaptation: t.adaptations?.length
                ? { at: t.adaptations[t.adaptations.length - 1]!.at, summary: t.adaptations[t.adaptations.length - 1]!.summary }
                : null,
              // next must come from the TITLED items — the raw queue's
              // label is the "— round N" string the redesign banned.
              next: withTitles ? nextUp(withTitles as unknown as Queue) : null,
              days: queue
                ? bucketIntoDays(withTitles as unknown as Queue, t, now)
                : null,
            };
          })
          // Nearest ROUND first (a loop's rounds carry their own dates);
          // the target date stands in for undated specs; undated targets last.
          .sort((a, b) => (nearestDeadline(a.target) ?? '9999') < (nearestDeadline(b.target) ?? '9999') ? -1 : 1);
        return json(200, {
          targets,
          focus,
          today: new Date(now).toISOString(),
          session_live: live,
          session_url: `http://localhost:${cfg.sessionPort}/session`,
        });
      }
      if (url === '/api/target' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as {
          label?: string; date?: string; description?: string; context?: string;
          attachments?: { name?: string; media_type?: string; data?: string }[];
        };
        if (!b.label?.trim()) return json(400, { error: 'label required' });
        // "AUg 20" stored verbatim rendered as "NaN days to Palantir". The
        // date is optional; a garbled one is an error, never silent data.
        const date = b.date?.trim() ?? '';
        if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`)))) {
          return json(400, { error: `couldn't read that date — write it like 2026-08-20 (got "${date}")` });
        }
        // Binary attachments: media-type allowlist + size caps, decoded and
        // written under the target dir. Rejecting BEFORE the target exists
        // keeps a bad upload from leaving a half-made plan behind.
        const incoming = b.attachments ?? [];
        if (incoming.length > MAX_ATTACHMENTS) {
          return json(400, { error: `${incoming.length} attachments — max ${MAX_ATTACHMENTS}` });
        }
        const decoded: { name: string; media_type: string; bytes: Buffer }[] = [];
        for (const a of incoming) {
          const mediaType = a.media_type ?? '';
          if (!ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
            return json(400, { error: `"${a.name ?? 'file'}": unsupported type ${mediaType || '(none)'} — images and PDFs only` });
          }
          const bytes = Buffer.from(a.data ?? '', 'base64');
          if (bytes.length === 0) return json(400, { error: `"${a.name ?? 'file'}" is empty` });
          if (bytes.length > MAX_ATTACHMENT_BYTES) {
            return json(400, { error: `"${a.name ?? 'file'}" is ${Math.round(bytes.length / 1024 / 1024)}MB — max 10MB` });
          }
          decoded.push({ name: (a.name ?? 'attachment').slice(0, 120), media_type: mediaType, bytes });
        }
        const t: Target = {
          id: `${slugify(b.label)}-${Date.now().toString(36)}`,
          label: b.label.trim(),
          ...(date ? { interview_date: date } : {}),
          description: b.description?.trim() ?? '',
          ...(b.context?.trim() ? { context: b.context.trim() } : {}),
          specs: [],
          created: new Date().toISOString(),
        };
        if (decoded.length > 0) {
          const dir = path.join(targetDir(repoRoot, t.id), 'attachments');
          mkdirSync(dir, { recursive: true });
          t.attachments = decoded.map((d, i) => {
            // basename + strip traversal: the name is client input.
            const safe = `${i + 1}-${path.basename(d.name).replace(/[^\w.\-]+/g, '_')}`;
            writeFileSync(path.join(dir, safe), d.bytes);
            return { name: d.name, media_type: d.media_type, file: path.join('attachments', safe) };
          });
        }
        saveTarget(repoRoot, t);
        return json(200, { id: t.id });
      }
      if (url === '/api/clarify' && req.method === 'POST') {
        // The intake reasoner: sees everything intake knows, returns 0-3
        // structured questions + 1+ round drafts. A contradiction inside
        // what the candidate provided becomes a QUESTION, and multiple
        // real rounds become multiple specs.
        const b = JSON.parse((await readBody(req)) || '{}') as {
          target_id?: string;
          answers?: { question: string; answer: string }[];
        };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (!t) return json(404, { error: 'no such target' });
        if (!t.description) return json(400, { error: 'describe the round first' });
        const { pickClarifier } = await import('./clarify.js');
        const { attachmentBlocks } = await import('./intake.js');
        try {
          const result = await pickClarifier(path.join(repoRoot, 'prompts', 'clarify-intake.md'))({
            description: t.description,
            context: t.context ?? '',
            answers: b.answers,
            attachments: attachmentBlocks(repoRoot, t),
          });
          return json(200, result);
        } catch (e) {
          // Gate failure or model failure: fall back to plain single-spec
          // inference rather than showing broken questions.
          console.warn(`[app] clarify failed, falling back to infer: ${String(e).slice(0, 200)}`);
          try {
            const infer = pickSpecInferrer(path.join(repoRoot, 'prompts', 'infer-round-spec.md'));
            const draft = await infer(t.description, t.context ?? '');
            return json(200, { questions: [], drafts: [draft] });
          } catch (e2) {
            return json(502, { error: `inference failed: ${String(e2).slice(0, 300)}` });
          }
        }
      }
      if (url === '/api/plan/turn' && req.method === 'POST') {
        // One planner conversation turn, awaited inline (the repo's pattern
        // for model calls — /api/clarify does the same). Research turns can
        // run 30-60s; the client shows determinate progress. Turns persist
        // only AFTER the model+gate succeed, so a 502 retry is idempotent.
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; message?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (!t) return json(404, { error: 'no such target' });
        if (!process.env.ANTHROPIC_API_KEY) {
          // The conversational planner needs typed content blocks + server
          // tools, which the claude -p path cannot carry. 501 tells the
          // client to fall back to the classic wizard.
          return json(501, { error: 'the conversational planner needs ANTHROPIC_API_KEY — falling back to the classic intake' });
        }
        if (!t.description && !b.message?.trim()) return json(400, { error: 'describe the round first' });
        if ((b.message ?? '').length > 32 * 1024) return json(400, { error: 'message too long — trim it to the relevant part' });
        const { runPlannerTurn } = await import('./planner.js');
        try {
          const result = await runPlannerTurn({
            root: repoRoot,
            target: t,
            templatePath: path.join(repoRoot, 'prompts', 'planner.md'),
            userMessage: b.message,
          });
          return json(200, { turns: result.turns, done: t.specs.length > 0 });
        } catch (e) {
          return json(502, { error: `planner turn failed: ${String(e).slice(0, 300)}` });
        }
      }
      if (url.startsWith('/api/plan/conversation')) {
        // Replay for resume — the fix for the orphan-target litter: a
        // target with a conversation and no specs picks up where it left
        // off instead of rotting as "finish setting up".
        const tid = new URL(url, 'http://x').searchParams.get('target') ?? '';
        const t = tid ? loadTarget(repoRoot, tid) : null;
        if (!t) return json(404, { error: 'no such target' });
        const { loadConversation, renderConversation, latestProposal } = await import('./planner.js');
        const turns = loadConversation(repoRoot, tid);
        return json(200, {
          turns: renderConversation(turns),
          proposal: latestProposal(turns),
          planner_available: Boolean(process.env.ANTHROPIC_API_KEY),
        });
      }
      if (url === '/api/target/delete' && req.method === 'POST') {
        // The other half of the abandoned-plan fix: an explicit way OUT.
        // Deleting removes the whole target dir — conversation, attachments,
        // generated problems. The candidate confirmed in the UI; traces and
        // assessments live outside the target dir and are untouched.
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (!t) return json(404, { error: 'no such target' });
        rmSync(targetDir(repoRoot, t.id), { recursive: true, force: true });
        return json(200, { ok: true });
      }
      if (url === '/api/accept-spec' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as {
          target_id?: string;
          spec?: RoundSpec;          // legacy single-spec shape
          specs?: RoundSpec[];       // multi-round accept
          /** Conversational pace override (1-7); falls back to the latest
           *  proposal's value, then the default. */
          pace_per_week?: number;
        };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        const incoming = b.specs ?? (b.spec ? [b.spec] : []);
        if (!t || incoming.length === 0) return json(400, { error: 'target_id and spec(s) required' });
        // The confirm gate re-proves the vocabulary server-side — the client
        // may have let the user edit the drafts.
        for (const spec of incoming) {
          const failures = validateRoundSpec(spec);
          if (failures.length > 0) return json(400, { error: `${spec?.id ?? 'spec'}: ${failures.join('; ')}` });
        }
        const ids = new Set(incoming.map((x) => x.id));
        t.specs = [...t.specs.filter((x) => !ids.has(x.id)), ...incoming];
        saveTarget(repoRoot, t);
        // Planner-settled facts feed generation: persist the summary the
        // model wrote at proposal time so the blueprint drafter reads it
        // (composeRoundBrief deliberately drops description/context once a
        // blueprint exists — this is the door conversation content takes).
        // The conversational pace ("about an hour a day" → 4/week) sizes the
        // queue; an explicit client value wins over the stored proposal.
        let pace: number | undefined =
          typeof b.pace_per_week === 'number' && Number.isFinite(b.pace_per_week)
            ? Math.min(7, Math.max(1, Math.round(b.pace_per_week)))
            : undefined;
        try {
          const { loadConversation, latestProposal } = await import('./planner.js');
          const prop = latestProposal(loadConversation(repoRoot, t.id));
          if (prop?.summary) {
            writeFileSync(path.join(targetDir(repoRoot, t.id), 'planner-summary.md'), prop.summary + '\n');
          }
          if (pace === undefined && prop?.pace_per_week) pace = prop.pace_per_week;
        } catch { /* no conversation — CLI or legacy path */ }
        if (!loadQueue(repoRoot, t.id)) {
          const queue = proposeQueue(t, Date.now(), pace);
          // Name every planned round now (D-impl): one call PER SPEC so a
          // multi-round queue gets titles that fit each round's shape.
          // Failure degrades to quiet rows — naming never blocks the plan.
          const namer = pickTopicNamer(path.join(repoRoot, 'prompts', 'plan-topics.md'));
          for (const spec of t.specs) {
            const mine = queue.items.filter((i) => i.spec_id === spec.id);
            if (mine.length === 0) continue;
            try {
              const brief = [
                `Round: ${spec.label}.`,
                spec.emphasis ? `Emphasis: ${spec.emphasis}.` : '',
                t.description ? `The candidate describes it as: ${t.description}` : '',
              ].filter(Boolean).join('\n');
              const titles = await namer(brief, mine.length);
              mine.forEach((item, i) => (item.planned_title = titles[i]));
            } catch (e) {
              console.warn(`[app] topic naming failed for ${spec.id} (quiet rows): ${String(e).slice(0, 200)}`);
            }
          }
          saveQueue(repoRoot, queue);
        }
        // Draft a blueprint per accepted spec, detached — the CLI is
        // idempotent (exits 0 when the file exists), so unconditional spawns
        // are safe and a re-accepted spec keeps its existing blueprint
        // (blueprint mutation belongs to adaptation, not re-accept). Drafter
        // failure never blocks this 200: generation falls back to the
        // legacy brief until a draft lands.
        for (const spec of incoming) {
          spawnDetached(['blueprint', t.id, spec.id]);
        }
        return json(200, { ok: true, specs: t.specs.map((x) => x.id) });
      }
      if (url === '/api/adapt' && req.method === 'POST') {
        // PREVIEW ONLY — computes a diff and writes NOTHING. No model
        // output reaches the plan without the candidate approving the
        // diff (D5); /api/adapt/apply is the only writer.
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; material?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (!t) return json(404, { error: 'no such target' });
        const material = (b.material ?? '').trim();
        if (!material) return json(400, { error: 'paste what you learned — an email, problem titles, a message' });
        if (material.length > 256 * 1024) {
          return json(400, { error: `that's ${Math.round(material.length / 1024)}KB — trim it to the relevant part (max 256KB)` });
        }
        const q = loadQueue(repoRoot, t.id);
        if (!q) return json(400, { error: 'no plan yet — build one first, then adapt it' });
        try {
          // The model sees only ACTIVE rounds — a retired spec is history,
          // not a supersession target; retired ids stay in the collision
          // universe so they can never be reused.
          const retired = retiredSpecIds(t);
          const activeSpecs = t.specs.filter((s) => !retired.has(s.id));
          // The model sees each active round's current blueprint — that is
          // what blueprint_edits revise. Absent files render as "(no
          // blueprint yet)".
          const outcome = await pickAdapter(path.join(repoRoot, 'prompts', 'adapt-plan.md'))({
            specs: activeSpecs,
            allSpecIds: t.specs.map((s) => s.id),
            blueprints: activeSpecs
              .map((s) => ({ spec_id: s.id, markdown: loadBlueprint(repoRoot, t.id, s.id) ?? '' }))
              .filter((b) => b.markdown),
            material,
          });
          const drafts = outcome.drafts;
          const diff = planAdaptation(t, q, drafts, outcome.blueprint_edits);
          // Name the re-pointed rounds NOW so the preview shows old → new
          // titles, not placeholders. Failure degrades to quiet rows.
          const namer = pickTopicNamer(path.join(repoRoot, 'prompts', 'plan-topics.md'));
          const bySpec = new Map<string, typeof diff.repointed>();
          for (const r of diff.repointed) {
            bySpec.set(r.to_spec_id, [...(bySpec.get(r.to_spec_id) ?? []), r]);
          }
          const allSpecs = [...t.specs, ...diff.new_specs];
          for (const [specId, rows] of bySpec) {
            const spec = allSpecs.find((s) => s.id === specId);
            if (!spec) continue;
            try {
              const brief = [
                `Round: ${spec.label}.`,
                spec.emphasis ? `Emphasis: ${spec.emphasis}.` : '',
                `The candidate just learned: ${material.slice(0, 2000)}`,
              ].filter(Boolean).join('\n');
              const titles = await namer(brief, rows.length);
              rows.forEach((r, i) => (r.new_title = titles[i]));
            } catch (e) {
              console.warn(`[app] adapt naming failed for ${specId} (quiet rows): ${String(e).slice(0, 200)}`);
            }
          }
          return json(200, {
            diff,
            drafts: drafts.map((d) => ({
              spec: d.spec,
              rationale: d.rationale,
              supersedes: d.supersedes,
              ...(d.unsupported ? { unsupported: d.unsupported } : {}),
            })),
          });
        } catch (e) {
          return json(502, { error: `couldn't read the material: ${String(e).slice(0, 300)}` });
        }
      }
      if (url === '/api/adapt/apply' && req.method === 'POST') {
        // The only writer. Re-proves the vocabulary server-side (the
        // client held the diff), re-loads fresh state, and writes
        // target.json FIRST (specs + record = the commit marker), then
        // queue.json — reconcileAdaptation repairs a death in between.
        const b = JSON.parse((await readBody(req)) || '{}') as {
          target_id?: string;
          diff?: AdaptDiff;
          /** Full raw note — appended verbatim to learnings.md. */
          material?: string;
          /** Legacy clients send only the excerpt; tolerated. */
          material_excerpt?: string;
        };
        const diff = b.diff;
        if (!b.target_id || !diff || !Array.isArray(diff.new_specs) || !Array.isArray(diff.repointed) || !Array.isArray(diff.flagged)) {
          return json(400, { error: 'target_id and a complete diff required' });
        }
        const t = loadTarget(repoRoot, b.target_id);
        const q = t ? loadQueue(repoRoot, t.id) : null;
        if (!t || !q) return json(404, { error: 'no such target or plan' });
        for (const spec of diff.new_specs) {
          const failures = validateRoundSpec(spec);
          if (failures.length > 0) return json(400, { error: `${spec?.id ?? 'spec'}: ${failures.join('; ')}` });
          if (t.specs.some((s) => s.id === spec.id)) {
            return json(400, { error: `spec "${spec.id}" already exists — specs are append-only` });
          }
        }
        const known = new Set([...t.specs, ...diff.new_specs].map((s) => s.id));
        for (const r of diff.repointed) {
          if (!known.has(r.to_spec_id)) return json(400, { error: `re-point targets unknown spec "${r.to_spec_id}"` });
        }
        // Blueprint rows re-prove the gate server-side (the client held the
        // diff). Tolerate absence — an in-flight preview from an old tab.
        for (const row of diff.blueprints ?? []) {
          if (!known.has(row.spec_id)) return json(400, { error: `blueprint targets unknown spec "${row.spec_id}"` });
          if (row.action !== 'new' && row.action !== 'revised') return json(400, { error: 'blueprint action out of vocabulary' });
          try {
            gateBlueprint(row.markdown);
          } catch (e) {
            return json(400, { error: `blueprint for ${row.spec_id}: ${String(e).slice(0, 200)}` });
          }
        }
        const material = (b.material ?? '').trim();
        if (material.length > 256 * 1024) return json(400, { error: 'material too large' });
        // Write order is deliberate: (1) the raw learning survives even if
        // everything after crashes; (2) blueprint files (.prev.md backup);
        // (3) target.json (the commit marker) then queue.json.
        if (material || b.material_excerpt) {
          appendLearnings(repoRoot, t.id, material || (b.material_excerpt ?? ''), Date.now());
        }
        for (const row of diff.blueprints ?? []) {
          writeBlueprintWithBackup(repoRoot, t.id, row.spec_id, row.markdown);
        }
        const applied = applyAdaptation(t, q, diff, material || (b.material_excerpt ?? ''), Date.now());
        saveTarget(repoRoot, applied.target);
        saveQueue(repoRoot, applied.queue);
        const record = applied.target.adaptations![applied.target.adaptations!.length - 1]!;
        console.log(`[app] adapted ${t.id}: ${record.summary}`);
        return json(200, { ok: true, record });
      }
      if (url === '/api/rebuild' && req.method === 'POST') {
        // A stale READY item: built under a superseded shape, never
        // launched — no candidate work exists in it, so regenerating in
        // place is safe. The dir is wiped so the old .validated marker
        // can't flip the item back to ready before generation runs.
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        const q = t ? loadQueue(repoRoot, t.id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!t || !q || !item?.problem_dir || item.status !== 'ready' || !item.stale) {
          return json(400, { error: 'item is not a stale ready problem' });
        }
        {
          const rd = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
          const gm = readGeneratingMarker(rd);
          if (gm && pidAlive(gm.pid)) {
            return json(409, { error: 'a generation is still running in that directory — give it a minute' });
          }
        }
        if (q.items.some((i) => i.status === 'generating')) {
          return json(409, { error: 'a problem is already generating — one at a time' });
        }
        const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
        rmSync(dir, { recursive: true, force: true });
        delete item.stale;
        item.status = 'generating';
        saveQueue(repoRoot, q);
        console.log(`[app] rebuilding ${t.id}/${item.id} under spec ${item.spec_id}`);
        spawnGeneration(t, item, dir);
        return json(200, { ok: true });
      }
      if (url === '/api/generate' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        const q = t ? loadQueue(repoRoot, t.id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!t || !q || !item || item.status !== 'pending') {
          return json(400, { error: 'item is not pending' });
        }
        if (q.items.some((i) => i.status === 'generating')) {
          return json(409, { error: 'a problem is already generating — one at a time' });
        }
        const dir = path.join(targetDir(repoRoot, t.id), 'problems', item.id);
        item.status = 'generating';
        item.problem_dir = dir;
        saveQueue(repoRoot, q);
        console.log(`[app] generating ${t.id}/${item.id} (user-initiated)`);
        spawnGeneration(t, item, dir);
        return json(200, { ok: true });
      }
      if (url === '/api/retry' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        const q = t ? loadQueue(repoRoot, t.id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!t || !q || !item?.problem_dir || item.status !== 'failed') {
          return json(400, { error: 'item is not in a failed state' });
        }
        const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
        // The double-agent guard (ISSUE-003): a false 'failed' can coexist
        // with a live detached generation for a moment — retrying then
        // would spawn a second agent into the same directory.
        const gm = readGeneratingMarker(dir);
        if (gm && pidAlive(gm.pid)) {
          return json(409, { error: 'that generation is actually still running — give it a minute' });
        }
        rmSync(path.join(dir, '.failed'), { force: true });
        item.status = 'generating';
        saveQueue(repoRoot, q);
        console.log(`[app] retrying generation for ${t.id}/${item.id}`);
        spawnGeneration(t, item, dir);
        return json(200, { ok: true });
      }
      if (url === '/api/skip' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const q = b.target_id ? loadQueue(repoRoot, b.target_id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!q || !item) return json(404, { error: 'no such item' });
        item.status = 'skipped';
        saveQueue(repoRoot, q);
        return json(200, { ok: true });
      }
      if (url === '/api/launch' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const q = b.target_id ? loadQueue(repoRoot, b.target_id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!q || !item?.problem_dir || item.status !== 'ready') {
          return json(400, { error: 'item is not ready' });
        }
        const probe = await probeSession(cfg.sessionPort);
        if (probe.reachable && !probe.ended) {
          return json(409, { error: 'a session is already running — finish or end it first' });
        }
        if (probe.reachable && probe.ended) {
          // A graded session's server lingers to serve its card; reap it so
          // the port is free for the new session.
          await postSession(cfg.sessionPort, '/api/shutdown');
          for (let i = 0; i < 10; i++) {
            if (!(await probeSession(cfg.sessionPort)).reachable) break;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        const sessionId = `sess-${Date.now()}`;
        // IP_PREPARE_NEXT=0: the queue drives generation now; the legacy
        // post-session prepare would write into the generic pool nobody is
        // drawing from in queue mode.
        spawnDetached(['session', item.problem_dir], {
          IP_SESSION_ID: sessionId,
          IP_USER_ID: cfg.userId,
          IP_PREPARE_NEXT: '0',
          IP_APP_URL: `http://localhost:${cfg.port}`,
        });
        return json(200, { session_id: sessionId, url: `http://localhost:${cfg.sessionPort}/session` });
      }
      if (url === '/api/session-live') {
        return json(200, { live: await sessionLive(cfg.sessionPort) });
      }
      if (url === '/api/session-kill' && req.method === 'POST') {
        // The masthead's "end session" (QA D1): abandon = discard, never
        // grade. The session server tears down its container and exits;
        // the trace stays on disk for a CLI rejudge.
        const r = await postSession(cfg.sessionPort, '/api/abandon');
        if (!r.ok) return json(502, { error: 'no session responded — it may already be gone' });
        return json(200, { ok: true });
      }
      res.writeHead(404);
      return res.end('not found');
    } catch (e) {
      return json(500, { error: String(e).slice(0, 300) });
    }
  });
  sweepOrphanedGenerations();
  server.listen(cfg.port, () => {
    console.log(`[app] open http://localhost:${cfg.port}/`);
  });
  return server;
}
