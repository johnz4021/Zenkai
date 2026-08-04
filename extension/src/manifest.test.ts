/**
 * The manifest is what the extension host reads before a single line of
 * extension.ts runs — two regressions live here permanently:
 * spike 3 (untrustedWorkspaces absent → Workspace Trust silently disables
 * the extension: zero events, zero logs) and the invisible-Run-Tests
 * finding (status-bar-only affordance → candidates ran tests in the
 * terminal, which the extension could not observe).
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module, no declaration file; vitest resolves it fine.
import { manifest } from '../manifest.mjs';

interface Manifest {
  main: string;
  activationEvents: string[];
  capabilities: { untrustedWorkspaces?: { supported: boolean } };
  contributes: {
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, { command: string; group: string; when?: string }[]>;
  };
}
const m = manifest as Manifest;

describe('extension manifest', () => {
  it('declares untrustedWorkspaces support — the spike-3 silent-death guard', () => {
    expect(m.capabilities.untrustedWorkspaces?.supported).toBe(true);
  });

  it('puts Run Tests in the editor title bar, gated by the canRunTests context key', () => {
    const entry = m.contributes.menus['editor/title']?.find(
      (e) => e.command === 'interviewPrep.runTests',
    );
    expect(entry).toBeDefined();
    expect(entry!.group).toBe('navigation');
    // Absent-not-disabled: no-run and one-shot rounds must not show the
    // button at all. Env can't reach manifest `when`, so activate() sets
    // this key from IP_CAN_RUN_TESTS.
    expect(entry!.when).toBe('interviewPrep.canRunTests');
    const cmd = m.contributes.commands.find((c) => c.command === 'interviewPrep.runTests');
    expect(cmd?.icon).toBe('$(beaker)');
  });

  it('activates on startup with the bundled entrypoint', () => {
    expect(m.activationEvents).toContain('onStartupFinished');
    expect(m.main).toBe('./extension.js');
  });
});
