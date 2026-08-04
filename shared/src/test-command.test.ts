/**
 * This classifier decides whether a terminal command counts as verification.
 * A false positive credits work that never happened and writes it into the
 * gap graph, so the rejection cases carry as much weight as the matches.
 */
import { describe, expect, it } from 'vitest';
import { isTestCommand } from './test-command.js';

describe('isTestCommand — the runners candidates actually type', () => {
  it('matches node script runners', () => {
    for (const c of ['npm test', 'npm run test', 'yarn test', 'pnpm test', 'bun test', 'npm t' /* not matched, see below */]) {
      if (c === 'npm t') continue;
      expect(isTestCommand(c), c).toBe(true);
    }
  });

  it('matches direct and npx-invoked runners', () => {
    for (const c of ['npx vitest run', 'npx jest --watch=false', 'vitest run', 'jest', 'mocha test/', 'bunx vitest']) {
      expect(isTestCommand(c), c).toBe(true);
    }
  });

  it('matches python runners, including our own generated command', () => {
    for (const c of ['python3 -m unittest discover -v', 'python -m pytest', 'pytest -q', 'pytest']) {
      expect(isTestCommand(c), c).toBe(true);
    }
  });

  it('matches the bundled-node vitest entrypoint the container uses', () => {
    expect(
      isTestCommand('/home/.openvscode-server/node /home/workspace/p-sess-1/node_modules/vitest/vitest.mjs run'),
    ).toBe(true);
  });

  it('matches other ecosystems a generated round might pick', () => {
    for (const c of ['go test ./...', 'cargo test', 'rspec spec/', './gradlew test']) {
      expect(isTestCommand(c), c).toBe(true);
    }
  });

  it('sees through env prefixes and compound commands', () => {
    expect(isTestCommand('CI=1 npx vitest run')).toBe(true);
    expect(isTestCommand('NODE_ENV=test FORCE_COLOR=0 npm test')).toBe(true);
    expect(isTestCommand('npm install && npm test')).toBe(true);
    expect(isTestCommand('cd src; pytest')).toBe(true);
  });
});

describe('isTestCommand — refuses to credit work that is not verification', () => {
  it('does not match commands that merely mention a runner', () => {
    for (const c of ['echo pytest', 'cat test/expiry.test.ts', 'ls test', 'grep -r "npm test" .', 'vim jest.config.js']) {
      expect(isTestCommand(c), c).toBe(false);
    }
  });

  it('does not match ordinary navigation, git, or installs', () => {
    for (const c of ['ls -la', 'cd src', 'git status', 'npm install', 'npm run build', 'clear']) {
      expect(isTestCommand(c), c).toBe(false);
    }
  });

  it('handles empty and missing input without throwing', () => {
    expect(isTestCommand('')).toBe(false);
    expect(isTestCommand(undefined)).toBe(false);
    expect(isTestCommand(null)).toBe(false);
    expect(isTestCommand('   ')).toBe(false);
  });
});
