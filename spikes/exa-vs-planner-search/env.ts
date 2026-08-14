/**
 * Key loading that defeats the shell-shadow trap.
 *
 *   .env (authoritative) ──► process.env  [OVERRIDING existing values]
 *                                │
 *                       warns when a shell export disagreed
 *
 * Why this exists rather than reusing cli.ts's loader. `process.loadEnvFile`
 * does NOT overwrite a variable already present in the environment — that is
 * deliberate and documented in cli.ts ("a shell export still wins"). It cost
 * this spike a full debugging cycle: a stale `ANTHROPIC_API_KEY` exported in
 * the shell shadowed the good key in `.env`, and every request 401'd with
 * "API key is invalid" while the file on disk was perfectly fine.
 *
 * For an experiment the precedence must run the other way: the file is the
 * thing under version-adjacent control, the shell is ambient noise. So this
 * overrides — and prints a warning naming any key where the two disagreed,
 * because a shadowed key is worth knowing about even once it stops mattering
 * here (the same stale export breaks `cli.ts app` from that shell).
 */

import { existsSync, readFileSync } from 'node:fs';

export const KEYS = ['ANTHROPIC_API_KEY', 'EXA_API_KEY', 'FIRECRAWL_API_KEY'] as const;
export type KeyName = (typeof KEYS)[number];

/** Minimal KEY=VALUE parse — enough for the three keys, no dependency. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

export function loadKeys(envPath: string): void {
  if (!existsSync(envPath)) {
    console.warn(`[env] no .env at ${envPath} — relying on the ambient environment`);
    return;
  }
  const fromFile = parseEnvFile(readFileSync(envPath, 'utf8'));
  for (const key of KEYS) {
    const fileVal = fromFile[key];
    if (!fileVal) continue;
    const shellVal = process.env[key];
    if (shellVal && shellVal !== fileVal) {
      console.warn(
        `[env] ${key}: a shell export (…${shellVal.slice(-6)}) disagreed with .env (…${fileVal.slice(-6)}). ` +
          `Using .env. Note cli.ts would use the SHELL value — unset it before running the app.`,
      );
    }
    process.env[key] = fileVal;
  }
}

export function requireKey(key: KeyName): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (add it to .env at the repo root)`);
  return v;
}
