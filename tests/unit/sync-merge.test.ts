import { describe, expect, it } from 'vitest';
import { hasConflictMarkers, linesWithEol, merge3 } from '$lib/sync/merge';
import { syncable } from '$lib/sync/paths';

const base = `2026-01-01 Opening
    assets:bank    100 EUR
    equity

2026-01-05 Grocer
    expenses:food   20 EUR
    assets:bank
`;

describe('merge3', () => {
  it('takes the only side that changed', () => {
    expect(merge3(base, base, 'x\n')).toEqual({ clean: true, text: 'x\n', conflicts: 0 });
    expect(merge3(base, 'y\n', base)).toEqual({ clean: true, text: 'y\n', conflicts: 0 });
    expect(merge3(base, 'z\n', 'z\n').text).toBe('z\n');
  });

  it('merges edits to different transactions', () => {
    const local = base.replace('100 EUR', '150 EUR');
    const remote = base.replace('20 EUR', '25 EUR');
    const r = merge3(base, local, remote);
    expect(r.clean).toBe(true);
    expect(r.text).toBe(base.replace('100 EUR', '150 EUR').replace('20 EUR', '25 EUR'));
  });

  it('merges edits to adjacent lines line by line', () => {
    const b = 'a\nb\nc\n';
    const r = merge3(b, 'A\nb\nc\n', 'a\nB\nc\n');
    expect(r).toEqual({ clean: true, text: 'A\nB\nc\n', conflicts: 0 });
  });

  it('keeps both transactions appended at the end on two devices (local first)', () => {
    const local = `${base}\n2026-01-07 Cafe\n    expenses:food   4 EUR\n    assets:bank\n`;
    const remote = `${base}\n2026-01-08 Fuel\n    expenses:car   40 EUR\n    assets:bank\n`;
    const r = merge3(base, local, remote);
    expect(r.clean).toBe(true);
    expect(r.text).toContain('Cafe');
    expect(r.text).toContain('Fuel');
    expect(r.text.indexOf('Cafe')).toBeLessThan(r.text.indexOf('Fuel'));
    // The shared blank-line separator is kept once, the rest of both inserts as written.
    expect(r.text.startsWith(base)).toBe(true);
  });

  it('reports overlapping edits with diff3 markers', () => {
    const local = base.replace('20 EUR', '21 EUR');
    const remote = base.replace('20 EUR', '22 EUR');
    const r = merge3(base, local, remote);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBe(1);
    expect(r.text).toContain('<<<<<<< local\n    expenses:food   21 EUR\n');
    expect(r.text).toContain('||||||| base\n    expenses:food   20 EUR\n');
    expect(r.text).toContain('=======\n    expenses:food   22 EUR\n>>>>>>> remote\n');
    expect(hasConflictMarkers(r.text)).toBe(true);
    expect(hasConflictMarkers(base)).toBe(false);
  });

  it('can turn off the insertion union', () => {
    const r = merge3('a\n', 'a\nb\n', 'a\nc\n', { unionInsertions: false });
    expect(r.clean).toBe(false);
  });

  it('keeps CRLF line endings and a missing final newline byte for byte', () => {
    const b = 'a\r\nb\r\nc';
    const r = merge3(b, 'A\r\nb\r\nc', 'a\r\nb\r\nC');
    expect(r).toEqual({ clean: true, text: 'A\r\nb\r\nC', conflicts: 0 });
    expect(linesWithEol('x\ny')).toEqual(['x\n', 'y']);
  });
});

describe('syncable', () => {
  it('accepts journal-ish extensions', () => {
    for (const p of ['main.journal', 'a.hledger', 'b.ledger', 'c.j', 'bank.csv.rules', 'x.csv', 'p.prices', 'y/2026.JOURNAL'])
      expect(syncable(p), p).toBe(true);
  });
  it('rejects other files and hidden folders', () => {
    for (const p of ['notes.md', 'img.png', '.git/config', '.trash/old.journal', 'a/.hidden/b.journal', 'journal'])
      expect(syncable(p), p).toBe(false);
    expect(syncable('.private.journal')).toBe(true);
  });
});
