/**
 * Retention is the only part that can destroy data, so it gets the paranoid
 * treatment: unrelated objects in a shared bucket must survive a sweep.
 */
import { describe, expect, it } from 'vitest';
import { BACKUP_PATHS, backupName, planRetention } from './backup.js';

describe('backupName', () => {
  it('is UTC, filename-safe, and lexically sortable', () => {
    const a = backupName(Date.parse('2026-08-13T09:05:00Z'));
    const b = backupName(Date.parse('2026-08-13T10:05:00Z'));
    expect(a).toMatch(/^zenkai-2026-08-13T09-05-00-000Z\.tar\.gz$/);
    expect([b, a].sort()).toEqual([a, b]); // sort order == chronological
    expect(a).not.toMatch(/[:]/); // ':' is illegal in object keys on some stores
  });
});

describe('planRetention', () => {
  const names = [
    'zenkai-2026-08-01T00-00-00-000Z.tar.gz',
    'zenkai-2026-08-02T00-00-00-000Z.tar.gz',
    'zenkai-2026-08-03T00-00-00-000Z.tar.gz',
  ];

  it('deletes the oldest beyond keep', () => {
    expect(planRetention(names, 2)).toEqual(['zenkai-2026-08-01T00-00-00-000Z.tar.gz']);
    expect(planRetention(names, 3)).toEqual([]);
    expect(planRetention(names, 99)).toEqual([]);
  });

  it('NEVER touches objects that are not ours — a shared bucket stays safe', () => {
    const shared = [...names, 'someone-elses-export.tar.gz', 'notes.md', 'zenkai-notes.txt'];
    const doomed = planRetention(shared, 1);
    expect(doomed).toEqual([
      'zenkai-2026-08-01T00-00-00-000Z.tar.gz',
      'zenkai-2026-08-02T00-00-00-000Z.tar.gz',
    ]);
    expect(doomed.some((d) => !d.startsWith('zenkai-') || !d.endsWith('.tar.gz'))).toBe(false);
  });

  it('keep<=0 deletes nothing — a misconfigured timer must not wipe history', () => {
    expect(planRetention(names, 0)).toEqual([]);
    expect(planRetention(names, -5)).toEqual([]);
  });
});

describe('BACKUP_PATHS', () => {
  it('covers what db.ts does NOT mirror, and never secrets', () => {
    expect(BACKUP_PATHS).toContain('gaps');    // not mirrored to Postgres
    expect(BACKUP_PATHS).toContain('topics');  // not mirrored to Postgres
    expect(BACKUP_PATHS).toContain('traces');
    expect(BACKUP_PATHS as readonly string[]).not.toContain('.env');
    expect(BACKUP_PATHS as readonly string[]).not.toContain('datasets'); // regenerable
    expect(BACKUP_PATHS as readonly string[]).not.toContain('problems'); // regenerable
  });
});
