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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRoundSpec, type GeneratedProblem, type RoundSpec } from '@interview-prep/shared';
import { listTargets, loadTarget, pickSpecInferrer, saveTarget, slugify, targetDir, type SpecDraft, type Target } from './intake.js';
import { bucketIntoDays, loadQueue, nextUp, proposeQueue, reconcileWithDisk, repace, saveQueue, type Queue, type QueueItem } from './queue.js';
import { buildGraphView, gapDescription, loadStore } from './gap-graph.js';
import { applyAdaptation, pickAdapter, planAdaptation, reconcileAdaptation, retiredSpecIds, type AdaptDiff } from './adapt.js';
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
  const child = spawn('npx', ['tsx', path.join(repoRoot, 'server', 'src', 'cli.ts'), ...args], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  child.on('close', (code) => {
    liveGenerations.delete(dir);
    if (code !== 0 && !existsSync(path.join(dir, '.validated'))) {
      writeFileSync(path.join(dir, '.failed'), `exit ${code} at ${new Date().toISOString()}\n`);
      console.warn(`[app] generation failed for ${item.id} (exit ${code})`);
    }
  });
}

/** App restart while a generation was mid-flight leaves items 'generating'
 *  with no child and no marker — indistinguishable from progress. Mark them
 *  failed once at boot so the timeline offers retry instead of spinning
 *  forever. */
function sweepOrphanedGenerations(): void {
  for (const t of listTargets(repoRoot)) {
    const q = loadQueue(repoRoot, t.id);
    if (!q) continue;
    for (const item of q.items) {
      if (item.status !== 'generating' || !item.problem_dir) continue;
      const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
      if (liveGenerations.has(dir)) continue;
      if (!existsSync(path.join(dir, '.validated')) && !existsSync(path.join(dir, '.failed'))) {
        writeFileSync(path.join(dir, '.failed'), `orphaned by app restart at ${new Date().toISOString()}\n`);
        console.warn(`[app] ${t.id}/${item.id} orphaned by restart — marked failed (retryable)`);
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64' fill='none'%3E%3Crect width='64' height='64' fill='%2317171a'/%3E%3Ccircle cx='32' cy='32' r='24' stroke='%230088b0' stroke-width='8' stroke-dasharray='118 33'/%3E%3Cpath d='M18 46 L52 12' stroke='%23e6e6ea' stroke-width='8'/%3E%3Cpath d='M40 12 L52 12 L52 24' stroke='%23e6e6ea' stroke-width='8' stroke-linejoin='miter'/%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&family=Source+Serif+4:opsz,wght@8..60,600&display=swap" rel="stylesheet" />
<style>
  :root {
    /* Brand plates, exactly as drawn on the identity sheet (Direction 2). */
    --plate-cyan: #0088b0; --plate-mag: #d6006c;
    /* UI derivations: both plates lifted for contrast on the dark ground.
       Cyan is the FORWARD axis (today, action, the interview itself);
       magenta is the ATTENTION axis (your gap, failures). Green still
       owns "done" — neither plate can carry completion. */
    --accent: #17a9d4; --accent-dim: rgba(23, 169, 212, .35);
    --mag: #e82b86; --mag-dim: rgba(232, 43, 134, .3);
    --line: #2a2a2e; --line-soft: #232327;
    --dim: #9a9aa2; --bright: #e6e6ea; --ok: #4caf7d;
    --bg: #17171a;
    --rail: 93px; /* x of the timeline spine: date col 74 + gap 14 + dot half */
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    margin: 0 auto; max-width: 760px; padding: 40px 20px 64px;
    font: 13px/1.55 'IBM Plex Mono', ui-monospace, monospace;
    background: var(--bg); color: var(--bright);
    min-height: 100vh;
  }
  /* Atmosphere: a faint violet aura at the crown and film grain over the
     field — depth without decoration; both invisible until you look. */
  body::before {
    content: ''; position: fixed; inset: 0; pointer-events: none; z-index: -1;
    background: radial-gradient(60% 40% at 50% -10%, rgba(23, 169, 212, .07), transparent 70%);
  }
  body::after {
    content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 9;
    opacity: .035; mix-blend-mode: overlay;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  ::selection { background: var(--accent); color: #fff; }

  .micro { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .18em; color: var(--dim); margin: 0 0 18px; }
  .meta { color: var(--dim); }
  .err { color: var(--mag); }
  a { color: inherit; }
  /* ---- masthead: the one persistent chrome, sticky over the grain ---- */
  nav {
    display: flex; justify-content: space-between; align-items: center;
    gap: 16px; margin: 0 -20px 30px; padding: 0 20px 16px;
    position: sticky; top: 0; z-index: 10;
    background: var(--bg); border-bottom: 1px solid var(--line-soft);
  }
  nav a { text-decoration: none; }
  /* Lockup: mark and wordmark side by side (identity sheet, Direction 2).
     The wordmark is the one serif in the product - an editorial voice
     against the instrument's monospace chrome. */
  .brand { display: flex; align-items: center; gap: 13px; }
  .brand svg { display: block; overflow: visible; }
  .brand .plate-mag { stroke: var(--plate-mag); }
  .brand .plate-cyan { stroke: var(--plate-cyan); }
  .brand .vector { stroke: var(--bright); }  /* reversed for the dark ground, per the sheet's own reversed-on-black variant */
  .brand svg .plate-cyan, .brand svg .vector { transition: filter .3s; }
  #nav-home:hover .plate-cyan { filter: drop-shadow(0 0 6px var(--accent-dim)); }
  .brand .word {
    font-family: 'Source Serif 4', serif; font-size: 25px; font-weight: 600;
    letter-spacing: -.01em; line-height: 1; color: var(--bright);
    transition: color .18s;
  }
  #nav-home:hover .word { color: #fff; }
  .navright { display: flex; align-items: center; gap: 18px; }
  #nav-live { display: none; align-items: center; gap: 7px; color: var(--accent); font-size: 12px; }
  #nav-live.on { display: flex; }
  #nav-kill { display: none; color: var(--dim); font-size: 12px; }
  #nav-kill.on { display: inline; }
  #nav-kill:hover { color: var(--mag); }
  #nav-live .pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; box-shadow: 0 0 0 0 var(--accent-dim); } 50% { opacity: .55; box-shadow: 0 0 0 4px transparent; } }
  #nav-new { color: var(--dim); font-size: 12px; transition: color .18s; }
  #nav-new:hover { color: var(--accent); }

  /* ---- first paint: the shape of the page before data lands ---- */
  #boot { padding-top: 6px; }
  #boot .sk { height: 11px; background: var(--line-soft); margin: 16px 0; animation: breathe 1.5s ease-in-out infinite; }
  #boot .sk:nth-child(1) { width: 42%; height: 30px; }
  #boot .sk:nth-child(2) { width: 100%; animation-delay: .1s; }
  #boot .sk:nth-child(3) { width: 78%; animation-delay: .2s; }
  #boot .sk:nth-child(4) { width: 88%; animation-delay: .3s; }
  @keyframes breathe { 0%, 100% { opacity: .5; } 50% { opacity: .22; } }

  /* ---- scrollbar: part of the instrument, not the OS ---- */
  * { scrollbar-width: thin; scrollbar-color: #33333a var(--bg); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: #2f2f36; border: 3px solid var(--bg); border-radius: 5px; }
  ::-webkit-scrollbar-thumb:hover { background: #43434c; }

  button {
    background: none; border: 1px solid var(--line); color: var(--bright);
    padding: 6px 14px; font: inherit; cursor: pointer; min-height: 32px;
    transition: border-color .18s, background .18s, box-shadow .18s;
  }
  button:hover { border-color: #45454c; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
  button.primary:hover { box-shadow: 0 0 22px var(--accent-dim); }
  :is(button, input, textarea, a, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input, textarea {
    width: 100%; background: rgba(255, 255, 255, .015); border: 1px solid var(--line);
    color: inherit; font: inherit; padding: 9px 11px; transition: border-color .18s;
  }
  input:hover, textarea:hover { border-color: #3a3a40; }
  input:focus, textarea:focus { border-color: var(--accent-dim); }
  label { display: block; margin: 18px 0 5px; font-weight: 500; }
  .banner { border: 1px solid var(--accent); background: rgba(124, 92, 255, .06); padding: 10px 14px; margin: 0 0 20px; }

  /* ---- entrance choreography: one orchestrated load per page, never on
         polls; fully off under reduced motion ---- */
  @keyframes rise { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
  .animate .runway li, .animate a.plancard, .animate .season > * { animation: rise .45s cubic-bezier(.2, .7, .2, 1) both; animation-delay: calc(var(--i, 0) * 32ms); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }

  /* ---- entry (make a plan) ---- */
  #entry h2 { font-size: 16px; font-weight: 500; margin: 0 0 8px; }
  #e-desc { min-height: 118px; }
  .optrow { display: flex; gap: 18px; }
  .optrow > div { flex: 1; }
  #refbox { border: 1px solid var(--line); padding: 14px 16px; margin-top: 20px; background: rgba(255, 255, 255, .012); }
  #refbox .help { color: var(--dim); margin: 2px 0 10px; }
  .linkrow { display: flex; gap: 8px; }
  .linkrow input { flex: 1; }
  #e-attachlist { margin-top: 4px; }
  .attach { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--line-soft); }
  .attach .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach .kind { color: var(--dim); font-size: 12px; }
  .attach button { border: 0; color: var(--dim); padding: 0 6px; min-height: 0; }
  .attach button:hover { color: var(--bright); }
  #e-build { width: 100%; margin-top: 24px; padding: 13px; min-height: 44px; letter-spacing: .02em; }
  .closing { border-top: 1px solid var(--line); margin-top: 28px; padding-top: 15px; color: var(--dim); }
  .findings p { margin: 7px 0; }
  .rationale { color: var(--dim); white-space: pre-wrap; }
  .specbox { border: 1px solid var(--line); padding: 13px 15px; margin: 10px 0; background: rgba(255, 255, 255, .012); }
  .specbox.dropped { opacity: .55; }
  .specbox .keep { display: inline-flex; gap: 6px; margin-left: 12px; color: var(--dim); font-weight: 400; }
  .specbox .keep input { width: auto; }
  .q { border: 1px solid var(--line); padding: 14px 16px; margin: 14px 0; background: rgba(255, 255, 255, .012); }
  .q .qtext { margin: 0 0 2px; font-weight: 500; }
  .q .qwhy { margin: 0 0 10px; }
  .q .opt { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; margin: 0; border-top: 1px solid var(--line-soft); cursor: pointer; }
  .q .opt input[type="radio"] { width: auto; accent-color: var(--accent); }
  .q .opt .rec { color: var(--accent); font-style: normal; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; margin-left: 6px; }
  .q .otherbox { width: 260px; display: inline-block; padding: 4px 8px; margin-left: 6px; }
  .progress { height: 2px; background: var(--line); margin: 16px 0; overflow: hidden; }
  .progress .fill { height: 100%; background: var(--accent); width: 30%; animation: slide 1.5s ease-in-out infinite alternate; box-shadow: 0 0 8px var(--accent-dim); }
  @keyframes slide { from { margin-left: 0; } to { margin-left: 70%; } }

  /* ---- all plans (index) ---- */
  a.plancard {
    display: block; border: 1px solid var(--line); padding: 16px; margin: 12px 0;
    text-decoration: none; background: rgba(255, 255, 255, .012);
    transition: border-color .18s, transform .18s;
  }
  a.plancard:hover { border-color: #45454c; transform: translateY(-1px); }
  .plancard h2 { font-size: 16px; font-weight: 500; margin: 0 0 4px; }
  .plancard .bar { height: 2px; background: var(--line); margin: 12px 0 8px; }
  .plancard .bar .fill { height: 100%; background: var(--accent); }
  .plancard .nextline { color: var(--dim); }
  .plancard.setup { color: var(--dim); }
  .plancard.setup .go { color: var(--accent); }
  .backlink { display: inline-block; color: var(--dim); text-decoration: none; margin-bottom: 16px; transition: color .18s; }
  .backlink:hover { color: var(--bright); }

  /* ---- season timeline: the countdown instrument ---- */
  .season { margin-bottom: 44px; }
  .season .daysleft { font-size: 17px; font-weight: 400; line-height: 1.2; margin: 0; color: var(--dim); }
  .season .daysleft b { font-size: 54px; font-weight: 600; letter-spacing: -.03em; color: var(--bright); display: inline-block; margin-right: 6px; vertical-align: -4px; text-shadow: 0 0 34px var(--accent-dim); }
  .seasonbar { height: 2px; background: var(--line); margin: 16px 0 7px; }
  .seasonbar .fill { height: 100%; background: var(--accent); box-shadow: 0 0 8px var(--accent-dim); transition: width .8s cubic-bezier(.2, .7, .2, 1); }
  .paceline { display: flex; justify-content: space-between; color: var(--dim); font-size: 12px; margin-bottom: 26px; }

  /* adaptation: the last change + the door for new information */
  .adaptrow { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; font-size: 12px; margin: -14px 0 22px; }
  .adaptrow .addlearn { color: var(--dim); text-decoration: none; border-bottom: 1px dotted var(--line); white-space: nowrap; }
  .adaptrow .addlearn:hover { color: var(--accent); border-bottom-color: var(--accent-dim); }
  .adaptpanel { border: 1px solid var(--line); padding: 15px; margin: 0 0 24px; background: rgba(255, 255, 255, .012); }
  .adaptpanel .learnbox { width: 100%; min-height: 96px; resize: vertical; }
  .adaptpanel .btnrow { margin-top: 12px; }
  .adaptpanel .adaptsum { font-weight: 500; margin-bottom: 10px; }
  .adaptpanel .repoint b { color: var(--bright); }
  .stale { color: var(--mag); }

  ol.runway { list-style: none; margin: 0; padding: 0; position: relative; }
  /* The spine: one continuous rail the whole season hangs from. */
  ol.runway::before { content: ''; position: absolute; left: var(--rail); top: 10px; bottom: 10px; width: 1px; background: var(--line); }
  .runway li { display: flex; gap: 14px; border-top: 1px solid var(--line-soft); padding: 9px 0; align-items: baseline; position: relative; }
  .runway li:first-child { border-top: 0; }
  .runway .date { width: 74px; flex: none; color: var(--dim); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .08em; }
  .runway .dot { flex: none; width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid var(--line); background: var(--bg); align-self: center; z-index: 1; position: relative; left: -1px; }
  .runway .body { flex: 1; min-width: 0; }
  .runway li.past { opacity: .5; }
  .runway li.past .dot.done { border-color: var(--ok); background: var(--ok); }
  .runway li.past .body .ok { color: var(--ok); margin-right: 6px; }
  .runway li.empty .body { color: var(--dim); }
  .runway li.today { padding: 18px 0; opacity: 1; border-top-color: var(--line); }
  .runway li.today .date { color: var(--accent); }
  .runway li.today .dot { border-color: var(--accent); background: var(--accent); box-shadow: 0 0 14px var(--accent-dim); }
  .runway li.today .title { font-size: 16px; font-weight: 500; }
  .runway .metaline { color: var(--dim); margin-top: 3px; font-size: 12px; }
  .runway .aimed { color: var(--mag); margin-top: 6px; font-style: italic; }  /* the gap is the attention axis */
  .runway li.today .body { display: flex; gap: 16px; align-items: center; }
  .runway li.today .grow { flex: 1; min-width: 0; }
  .runway li.today button.primary { min-width: 96px; min-height: 44px; }
  .runway li.future { color: #c9c9cf; }
  .runway li.future.empty { padding: 5px 0; }
  .runway li.future.empty .dot { width: 5px; height: 5px; border-width: 1px; left: 2px; }
  .runway li.collapsed .body { color: var(--dim); }
  .runway li.collapsed .dot { border-style: dashed; background: transparent; }
  .runway li.interview { padding: 16px 0; color: var(--accent); border-top: 1px solid var(--line); }
  .runway li.interview .date { color: var(--accent); }
  .runway li.interview .dot { border-color: var(--accent); background: transparent; box-shadow: 0 0 10px var(--accent-dim); }
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
    <div id="entry-form">
      <h2><label for="e-desc" style="margin:0">What are you interviewing for?</label></h2>
      <textarea id="e-desc" placeholder="Palantir new grad. Recruiter email says 90 min HackerRank. The assessment preview showed class stubs to implement — so LLD-style, not just algorithms."></textarea>
      <div class="optrow">
        <div>
          <label for="e-date">Interview date <span class="meta">(optional)</span></label>
          <input id="e-date" placeholder="2026-09-15" />
        </div>
        <div>
          <label for="e-company">Company <span class="meta">(optional)</span></label>
          <input id="e-company" placeholder="Palantir" />
        </div>
      </div>
      <div id="refbox">
        <label for="e-link" style="margin-top:0">Reference material</label>
        <p class="help">a question from this round, a repo, a thread — this is what makes the generated problems feel real</p>
        <div class="linkrow">
          <input id="e-link" placeholder="paste a link — github.com/user/repo, a Blind thread, a writeup" />
          <button id="e-addlink" type="button">add</button>
          <button id="e-browse" type="button">browse files</button>
          <input id="e-file" type="file" multiple hidden aria-hidden="true" />
        </div>
        <div id="e-attachlist"></div>
      </div>
      <button id="e-build" class="primary" type="button">Build my plan</button>
      <p class="err" id="e-err" aria-live="polite"></p>
      <p class="closing">Everything you paste shapes the plan — and you confirm every round before anything gets built.</p>
    </div>
    <div id="entry-flow" hidden aria-live="polite"></div>
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
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(body);
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
                  items: queue.items.map((i) => ({ ...i, title: resolveTitle(i) })),
                }
              : null;
            return {
              target: {
                id: t.id,
                label: t.label,
                interview_date: t.interview_date ?? null,
                specs: t.specs.map((s) => ({ id: s.id, label: s.label, capabilities: s.capabilities })),
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
          // Nearest interview first; undated targets last.
          .sort((a, b) => (a.target.interview_date ?? '9999') < (b.target.interview_date ?? '9999') ? -1 : 1);
        return json(200, {
          targets,
          focus,
          today: new Date(now).toISOString(),
          session_live: live,
          session_url: `http://localhost:${cfg.sessionPort}/session`,
        });
      }
      if (url === '/api/target' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { label?: string; date?: string; description?: string; context?: string };
        if (!b.label?.trim()) return json(400, { error: 'label required' });
        // "AUg 20" stored verbatim rendered as "NaN days to Palantir". The
        // date is optional; a garbled one is an error, never silent data.
        const date = b.date?.trim() ?? '';
        if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`)))) {
          return json(400, { error: `couldn't read that date — write it like 2026-08-20 (got "${date}")` });
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
        try {
          const result = await pickClarifier(path.join(repoRoot, 'prompts', 'clarify-intake.md'))({
            description: t.description,
            context: t.context ?? '',
            answers: b.answers,
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
      if (url === '/api/accept-spec' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as {
          target_id?: string;
          spec?: RoundSpec;          // legacy single-spec shape
          specs?: RoundSpec[];       // multi-round accept
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
        if (!loadQueue(repoRoot, t.id)) {
          const queue = proposeQueue(t, Date.now());
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
          const drafts = await pickAdapter(path.join(repoRoot, 'prompts', 'adapt-plan.md'))({
            specs: t.specs.filter((s) => !retired.has(s.id)),
            allSpecIds: t.specs.map((s) => s.id),
            material,
          });
          const diff = planAdaptation(t, q, drafts);
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
        const applied = applyAdaptation(t, q, diff, b.material_excerpt ?? '', Date.now());
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
