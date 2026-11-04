import { describe, expect, it } from 'vitest';
import type { Txn, VaultSnapshot } from '../../src/lib/contracts/engine';
import { StalePatchError, type TxnDraft } from '../../src/lib/contracts/writer';
import { apply, draftFromTxn, planAdd, planDelete, planEdit, planReplaceText, writer } from '../../src/lib/journal/writer';
import { scanTxns } from '../fidelity/helpers';

const vault = (text: string, extra: Record<string, string> = {}): VaultSnapshot => ({ rootFile: 'main.journal', files: { 'main.journal': text, ...extra }, revision: 'r' });
const txnAt = (startLine: number, endLine: number, file = 'main.journal', date = '2024-01-01'): Txn => ({
  index: 1,
  date,
  status: '',
  code: '',
  description: '',
  comment: '',
  tags: [],
  postings: [],
  source: { file, startLine, endLine },
});
const run = (s: VaultSnapshot, patches: ReturnType<typeof planAdd>, file = 'main.journal') => apply(s.files, patches)[file]!;
const draft = (date = '2024-01-02', description = 'New'): TxnDraft => ({
  date,
  description,
  postings: [{ account: 'expenses:food', amount: '5', commodity: '$' }, { account: 'assets:cash' }],
});

const ABC = '2024-01-01 A\n    a  $1\n    b\n\n2024-01-02 B\n    a  $1\n    b\n\n2024-01-03 C\n    a  $1\n    b\n';

describe('planAdd', () => {
  it('appends with exactly one blank line before', () => {
    const s = vault('2024-01-01 A\n    a  $1\n    b\n');
    expect(run(s, planAdd(s, draft()))).toBe('2024-01-01 A\n    a  $1\n    b\n\n2024-01-02 New\n    expenses:food  $5\n    assets:cash\n');
    const t = vault('2024-01-01 A\n    a  $1\n    b\n\n');
    expect(run(t, planAdd(t, draft()))).toBe('2024-01-01 A\n    a  $1\n    b\n\n2024-01-02 New\n    expenses:food  $5\n    assets:cash\n');
  });

  it('keeps a file without a final newline without one', () => {
    const s = vault('2024-01-01 A\n    a  $1\n    b');
    expect(run(s, planAdd(s, draft()))).toBe('2024-01-01 A\n    a  $1\n    b\n\n2024-01-02 New\n    expenses:food  $5\n    assets:cash');
  });

  it('writes into an empty or missing file, and to a target file', () => {
    const s = vault('');
    expect(run(s, planAdd(s, draft()))).toBe('2024-01-02 New\n    expenses:food  $5\n    assets:cash\n');
    const t = vault('2024-01-01 A\n    a  $1.00\n    b\n');
    const patches = planAdd(t, draft(), { targetFile: '2024.journal' });
    expect(patches[0]!.file).toBe('2024.journal');
    expect(apply(t.files, patches)['2024.journal']).toBe('2024-01-02 New\n    expenses:food  $5.00\n    assets:cash\n');
  });

  it('preserves CRLF and BOM', () => {
    const s = vault('﻿2024-01-01 A\r\n    a  $1\r\n    b\r\n');
    expect(run(s, planAdd(s, draft()))).toBe('﻿2024-01-01 A\r\n    a  $1\r\n    b\r\n\r\n2024-01-02 New\r\n    expenses:food  $5\r\n    assets:cash\r\n');
  });

  it('dateOrder: inserts before the first later transaction of the file', () => {
    const s = vault(ABC);
    const out = run(s, planAdd(s, draft('2024-01-02', 'Mid'), { dateOrder: true, txns: scanTxns(ABC, 'main.journal') }));
    // Same date goes after the existing one.
    expect(out).toBe(ABC.replace('2024-01-03 C', '2024-01-02 Mid\n    expenses:food  $5\n    assets:cash\n\n2024-01-03 C'));
    const first = run(s, planAdd(s, draft('2023-12-31', 'First'), { dateOrder: true, txns: scanTxns(ABC, 'main.journal') }));
    expect(first.startsWith('2023-12-31 First\n    expenses:food  $5\n    assets:cash\n\n2024-01-01 A\n')).toBe(true);
    const last = run(s, planAdd(s, draft('2025-01-01', 'Last'), { dateOrder: true, txns: scanTxns(ABC, 'main.journal') }));
    expect(last.endsWith('    b\n\n2025-01-01 Last\n    expenses:food  $5\n    assets:cash\n')).toBe(true);
  });

  it('dateOrder: goes above comments attached to the later transaction, and ignores other files', () => {
    const text = '2024-01-01 A\n    a  $1\n    b\n\n; about B\n2024-01-05 B\n    a  $1\n    b\n';
    const s = vault(text);
    const other = txnAt(1, 3, 'other.journal', '2024-01-02');
    const out = run(s, planAdd(s, draft('2024-01-03'), { dateOrder: true, txns: [other, ...scanTxns(text, 'main.journal')] }));
    expect(out).toBe('2024-01-01 A\n    a  $1\n    b\n\n2024-01-03 New\n    expenses:food  $5\n    assets:cash\n\n; about B\n2024-01-05 B\n    a  $1\n    b\n');
  });

  it('dateOrder: adds a blank line when the transaction above has none', () => {
    const text = 'P 2024-01-01 EUR $1\n2024-01-05 B\n    a  $1\n    b\n';
    const s = vault(text);
    const out = run(s, planAdd(s, draft('2024-01-03'), { dateOrder: true, txns: scanTxns(text, 'main.journal') }));
    expect(out).toBe('P 2024-01-01 EUR $1\n\n2024-01-03 New\n    expenses:food  $5\n    assets:cash\n\n2024-01-05 B\n    a  $1\n    b\n');
  });
});

describe('planEdit', () => {
  it('a no-op edit makes no patch', () => {
    const s = vault(ABC);
    const t = txnAt(5, 7);
    expect(planEdit(s, t, draftFromTxn(t, s))).toEqual([]);
  });

  it('a description change touches only the header line', () => {
    const text = '2024-01-15 * (1001) Paycheck ; category:income\n    assets:bank:checking  $3500.00\n    income:salary\n';
    const s = vault(text);
    const t = txnAt(1, 3);
    const d = { ...draftFromTxn(t, s), description: 'Salary' };
    const patches = planEdit(s, t, d);
    expect(patches).toEqual([
      { op: 'replace', file: 'main.journal', startLine: 1, endLine: 3, expected: text.slice(0, -1), text: text.slice(0, -1).replace('Paycheck', 'Salary') },
    ]);
  });

  it('an amount change keeps the posting aligned and other lines identical', () => {
    const text = '2024-01-01 x\n    expenses:food            $10.00  ; note\n    assets:cash             $-10.00 = $0.00\n';
    const s = vault(text);
    const t = txnAt(1, 3);
    const d = draftFromTxn(t, s);
    d.postings[1]!.amount = '-9.5';
    d.postings[0]!.amount = '9.50';
    expect(run(s, planEdit(s, t, d))).toBe('2024-01-01 x\n    expenses:food             $9.50  ; note\n    assets:cash              $-9.50 = $0.00\n');
  });

  it('numerically equal amounts keep the original text', () => {
    const text = '2024-01-01 x\n    a  -$12.5\n    b\n';
    const s = vault(text);
    const t = txnAt(1, 3);
    const d = draftFromTxn(t, s);
    d.postings[0]!.amount = '-12.50';
    expect(planEdit(s, t, d)).toEqual([]);
  });

  it('keeps unchanged postings when one is added or removed', () => {
    const text = '2024-01-01 x\n    a        $1  ; one\n    b        $2\n    c\n';
    const s = vault(text);
    const t = txnAt(1, 4);
    const d = draftFromTxn(t, s);
    expect(run(s, planEdit(s, t, { ...d, postings: [d.postings[0]!, d.postings[2]!] }))).toBe('2024-01-01 x\n    a        $1  ; one\n    c\n');
    const added = run(s, planEdit(s, t, { ...d, postings: [d.postings[0]!, { account: 'z', amount: '3', commodity: '$' }, ...d.postings.slice(1)] }));
    // The new posting lines up with this transaction's own amount column.
    expect(added).toBe('2024-01-01 x\n    a        $1  ; one\n    z        $3\n    b        $2\n    c\n');
  });

  it('header comment lines and posting comment lines are kept unless changed', () => {
    const text = '2024-01-01 x  ; a\n    ; b\n    e  $1  ; c\n    ; d\n    f\n';
    const s = vault(text);
    const t = txnAt(1, 5);
    const d = draftFromTxn(t, s);
    expect(d.comment).toBe('a\nb');
    expect(d.postings[0]!.comment).toBe('c\nd');
    d.postings[0]!.comment = 'c\nD2';
    expect(run(s, planEdit(s, t, d))).toBe('2024-01-01 x  ; a\n    ; b\n    e  $1  ; c\n    ; D2\n    f\n');
  });

  it('does not trust the span end: trims extra lines and extends a short span', () => {
    const text = '2024-01-01 A\n    a  $1\n    b\n\naccount foo\n';
    const s = vault(text);
    const long = txnAt(1, 5);
    const d = { ...draftFromTxn(long, s), description: 'Z' };
    expect(planEdit(s, long, d)[0]).toMatchObject({ startLine: 1, endLine: 3 });
    const short = txnAt(1, 2);
    expect(planEdit(s, short, d)[0]).toMatchObject({ startLine: 1, endLine: 3 });
    expect(planDelete(s, short)[0]).toMatchObject({ startLine: 1, endLine: 4 });
  });

  it('a span whose start is not a transaction header is stale', () => {
    const s = vault(ABC);
    expect(() => planEdit(s, txnAt(2, 3), draft())).toThrow(StalePatchError);
    expect(() => planDelete(s, txnAt(99, 100))).toThrow(StalePatchError);
    expect(() => planEdit(s, txnAt(1, 3, 'missing.journal'), draft())).toThrow(StalePatchError);
    const { source: _, ...generated } = txnAt(1, 3);
    expect(() => planEdit(s, { ...generated, generated: true }, draft())).toThrow(/not in any file/);
  });

  it('works in CRLF files and keeps CRLF', () => {
    const text = ABC.replace(/\n/g, '\r\n');
    const s = vault(text);
    const t = txnAt(5, 7);
    const out = run(s, planEdit(s, t, { ...draftFromTxn(t, s), description: 'BB' }));
    expect(out).toBe(text.replace('2024-01-02 B', '2024-01-02 BB'));
  });
});

describe('planReplaceText', () => {
  it('normalises EOLs to the file and drops trailing blank lines', () => {
    const text = ABC.replace(/\n/g, '\r\n');
    const s = vault(text);
    const out = run(s, planReplaceText(s, txnAt(5, 7), '2024-01-02 Raw\n    x  $1\n    y\n\n'));
    expect(out).toBe(text.replace('2024-01-02 B\r\n    a  $1\r\n    b', '2024-01-02 Raw\r\n    x  $1\r\n    y'));
  });

  it('empty text deletes the transaction', () => {
    const s = vault(ABC);
    expect(planReplaceText(s, txnAt(5, 7), '  \n')).toEqual(planDelete(s, txnAt(5, 7)));
  });
});

describe('planDelete', () => {
  it('removes the transaction and one separator, no double blank lines (ported)', () => {
    const s = vault(ABC);
    const out = run(s, planDelete(s, txnAt(5, 7)));
    expect(out).toBe('2024-01-01 A\n    a  $1\n    b\n\n2024-01-03 C\n    a  $1\n    b\n');
    expect(out).not.toContain('\n\n\n');
  });

  it('first and last transactions', () => {
    const s = vault(ABC);
    expect(run(s, planDelete(s, txnAt(1, 3)))).toBe('2024-01-02 B\n    a  $1\n    b\n\n2024-01-03 C\n    a  $1\n    b\n');
    expect(run(s, planDelete(s, txnAt(9, 11)))).toBe('2024-01-01 A\n    a  $1\n    b\n\n2024-01-02 B\n    a  $1\n    b\n');
  });

  it('keeps a missing final newline missing, and CRLF (ported)', () => {
    const s = vault('2024-01-01 A\n    a  $1\n    b\n\n2024-01-02 B\n    a  $1\n    b');
    expect(run(s, planDelete(s, txnAt(5, 7)))).toBe('2024-01-01 A\n    a  $1\n    b');
    const c = vault('2024-01-01 x\r\n    a  $1.00\r\n    b\r\n');
    expect(run(c, planDelete(c, txnAt(1, 3)))).toBe('');
  });

  it('never touches neighbouring content', () => {
    const text = '; header\n2024-01-01 A\n    a  $1\n    b\nP 2024-01-01 EUR $1\n';
    const s = vault(text);
    expect(run(s, planDelete(s, txnAt(2, 4)))).toBe('; header\nP 2024-01-01 EUR $1\n');
  });
});

describe('writer object', () => {
  it('implements the Writer contract', () => {
    expect(Object.keys(writer).sort()).toEqual(['apply', 'formatTxn', 'inferStyle', 'planAdd', 'planDelete', 'planEdit', 'planReplaceText']);
  });
});
