/**
 * The extension manifest, extracted from build.mjs so it can be asserted on
 * without running a build. Two things in here are load-bearing history:
 *
 * - capabilities.untrustedWorkspaces: without it, Workspace Trust silently
 *   disables the extension the moment a folder is open (spike 3 — zero
 *   events, zero logs).
 * - the editor/title menu entry: the Run Tests affordance used to be ONLY a
 *   status-bar item, and a replay over 19 real traces found it barely
 *   pressed — candidates fell back to the terminal, which the extension
 *   could not observe. HackerRank's project IDE keeps Run Tests as a
 *   prominent button; now so does ours. Gated by a context key (set in
 *   activate() from IP_CAN_RUN_TESTS) because manifest `when` clauses
 *   cannot read env.
 */
export const manifest = {
  name: 'trace-emitter',
  publisher: 'interview-prep',
  version: '0.0.1',
  engines: { vscode: '^1.80.0' },
  main: './extension.js',
  activationEvents: ['onStartupFinished'],
  extensionKind: ['workspace'],
  capabilities: {
    untrustedWorkspaces: {
      supported: true,
      description: 'Observes editor events only; does not evaluate workspace code.',
    },
  },
  contributes: {
    commands: [
      {
        command: 'interviewPrep.runTests',
        title: 'Interview Prep: Run Tests',
        icon: '$(beaker)',
      },
    ],
    menus: {
      'editor/title': [
        {
          command: 'interviewPrep.runTests',
          group: 'navigation',
          when: 'interviewPrep.canRunTests',
        },
      ],
    },
  },
};
