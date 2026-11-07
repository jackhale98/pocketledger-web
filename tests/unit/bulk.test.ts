import { describe, expect, it } from 'vitest';
import { accountsUsed, bottomUp, planBulk } from '../../src/lib/journal/bulk';
import type { Txn } from '../../src/lib/contracts/engine';
import { findTxnSpans } from '../../src/lib/journal/locate';
import { hasWasm, makeEngine, snapshot } from '../helpers/engine';

const A = [
  '; header comment',
  '2026-01-01 * (101) Shop | groceries  ; tag: x',
  '    expenses:food                $10.00',
  '    expenses:food:snacks          $2.00',
  '    assets:cash',
  '',
  '2026-01-02 Cafe',
  '    expenses:coffee               $3.00  ; expenses:food in a comment',
  '    assets:cash',
  '',
  '2026-01-03 ! Market',
  '    expenses:food                 $5.00',
  '    (budget:food)                $-5.00',
  '    liabilities:card',
  '',
].join('\n');
const B = '2026-02-01 Shop\n    expenses:food  $1\n    assets:cash\n\n2026-02-02 Shop\n    expenses:food  $1\n    assets:cash\n';

/** Transactions with source spans, the way the engine reports them (postings only as far as tests need). */
function txnsOf(files: Record<string, string>): Txn[] {
  let index = 0;
  return Object.entries(files).flatMap(([file, text]) =>
    findTxnSpans(text, file).map((source) => {
      const lines = text.split(/\r?\n/).slice(source.startLine - 1, source.endLine);
      const postings = lines.slice(1).map((l) => ({ account: l.trim().split(/\s{2,}/)[0]!.replace(/^[([]|[)\]]$/g, '') }));
      return { index: ++index, date: lines[0]!.slice(0, 10), status: '', code: '', description: '', comment: '', tags: [], postings, source } as unknown as Txn;
    }),
  );
}

describe('bulk planner', () => {
  const files = { 'a.journal': A, 'b.journal': B };
  const txns = txnsOf(files);

  it('orders bottom-up per file, once per span, skipping generated ones', () => {
    const { source: _s, ...rest } = txns[0]!;
    const gen: Txn = { ...rest, generated: true };
    const order = bottomUp([txns[0]!, txns[3]!, txns[2]!, txns[0]!, gen, txns[4]!]);
    expect(order.map((t) => `${t.source!.file}:${t.source!.startLine}`)).toEqual(['a.journal:11', 'a.journal:2', 'b.journal:5', 'b.journal:1']);
  });

  it('lists accounts used by the selection', () => {
    expect(accountsUsed([txns[0]!, txns[2]!])).toEqual(['assets:cash', 'budget:food', 'expenses:food', 'expenses:food:snacks', 'liabilities:card']);
  });

  it('changes one account (not its subaccounts) and keeps everything else', () => {
    const r = planBulk(files, 'a.journal', txns, { kind: 'account', from: 'expenses:food', to: 'expenses:groceries' });
    expect(r.changed).toBe(4);
    expect(r.unchanged).toBe(1); // the cafe has no expenses:food posting
    const out = r.files['a.journal']!.split('\n');
    const before = A.split('\n');
    expect(out).toHaveLength(before.length);
    expect(out[2]).toBe('    expenses:groceries           $10.00');
    expect(out[3]).toBe(before[3]); // expenses:food:snacks is a different account
    expect(out[7]).toBe(before[7]); // a comment mentioning it
    expect(out[11]).toBe('    expenses:groceries            $5.00');
    expect(out[12]).toBe(before[12]);
    for (const i of [0, 1, 4, 5, 6, 8, 9, 10, 13, 14]) expect(out[i]).toBe(before[i]);
    expect(r.files['b.journal']).toBe(B.replace(/expenses:food/g, 'expenses:groceries'));
    expect(() => planBulk(files, 'a.journal', txns, { kind: 'account', from: 'expenses:food', to: 'a  b' })).toThrow();
  });

  it('sets the header status, keeping date, code, description and comment', () => {
    const cleared = planBulk(files, 'a.journal', txns, { kind: 'status', status: '*' });
    expect(cleared.changed).toBe(4);
    expect(cleared.unchanged).toBe(1);
    const out = cleared.files['a.journal']!.split('\n');
    expect(out[1]).toBe(A.split('\n')[1]);
    expect(out[6]).toBe('2026-01-02 * Cafe');
    expect(out[10]).toBe('2026-01-03 * Market');
    const unmarked = planBulk(files, 'a.journal', txns.slice(0, 1), { kind: 'status', status: '' }).files['a.journal']!.split('\n');
    expect(unmarked[1]).toBe('2026-01-01 (101) Shop | groceries  ; tag: x');
    const pending = planBulk(files, 'a.journal', txns.slice(0, 1), { kind: 'status', status: '!' }).files['a.journal']!.split('\n');
    expect(pending[1]).toBe('2026-01-01 ! (101) Shop | groceries  ; tag: x');
    expect(planBulk(files, 'a.journal', txns.slice(0, 1), { kind: 'status', status: '*' }).files).toEqual(files);
  });

  it('deletes several transactions bottom-up with no double blank lines', () => {
    const r = planBulk(files, 'a.journal', [txns[0]!, txns[2]!, txns[4]!], { kind: 'delete' });
    expect(r.changed).toBe(3);
    expect(r.files['a.journal']).toBe(['; header comment', '2026-01-02 Cafe', '    expenses:coffee               $3.00  ; expenses:food in a comment', '    assets:cash', ''].join('\n'));
    expect(r.files['b.journal']).toBe('2026-02-01 Shop\n    expenses:food  $1\n    assets:cash\n');
    const all = planBulk(files, 'a.journal', txns, { kind: 'delete' });
    expect(all.files['a.journal']).toBe('; header comment\n');
    expect(all.files['b.journal']).toBe('');
  });

  it('preserves CRLF and a BOM', () => {
    const crlf = { 'a.journal': '﻿' + A.replace(/\n/g, '\r\n') };
    const t = txnsOf(crlf);
    const r = planBulk(crlf, 'a.journal', t, { kind: 'account', from: 'expenses:food', to: 'expenses:groceries' });
    expect(r.files['a.journal']).toBe('﻿' + A.replace(/\n/g, '\r\n').replace(/expenses:food      /g, 'expenses:groceries ').replace('expenses:groceries  :snacks', 'expenses:food:snacks'));
    expect(r.files['a.journal']!.startsWith('﻿')).toBe(true);
    expect(r.files['a.journal']!.match(/\r\n/g)!.length).toBe(A.match(/\n/g)!.length);
    const d = planBulk(crlf, 'a.journal', t.slice(1, 2), { kind: 'delete' });
    expect(d.files['a.journal']).toBe('﻿' + A.replace(/\n/g, '\r\n').replace('2026-01-02 Cafe\r\n    expenses:coffee               $3.00  ; expenses:food in a comment\r\n    assets:cash\r\n\r\n', ''));
  });
});

describe.skipIf(!hasWasm)('bulk planner with hledger', () => {
  it('hledger reads the result and balances move as expected', async () => {
    const files = { 'main.journal': 'include b.journal\n\n' + A, 'b.journal': B };
    const e = await makeEngine();
    expect((await e.load(snapshot(files, 'main.journal'))).ok).toBe(true);
    const txns = await e.transactions();
    expect(txns.every((t) => t.source)).toBe(true);
    const r = planBulk(files, 'main.journal', txns, { kind: 'account', from: 'expenses:food', to: 'expenses:groceries' });
    const r2 = planBulk(r.files, 'main.journal', txns.filter((t) => t.description === 'Cafe'), { kind: 'delete' });
    const e2 = await makeEngine();
    expect((await e2.load(snapshot(r2.files, 'main.journal'))).ok).toBe(true);
    const bal = await e2.balance();
    const get = (a: string) => bal.rows.find((x) => x.account === a)?.amount[0]?.quantity;
    expect(Number(get('expenses:groceries'))).toBe(17);
    expect(get('expenses:food')).toBeUndefined();
    expect(Number(get('expenses:food:snacks'))).toBe(2);
    expect(get('expenses:coffee')).toBeUndefined();
    const st = planBulk(r2.files, 'main.journal', (await e2.transactions()), { kind: 'status', status: '*' });
    const e3 = await makeEngine();
    expect((await e3.load(snapshot(st.files, 'main.journal'))).ok).toBe(true);
    expect((await e3.transactions()).every((t) => t.status === '*')).toBe(true);
  });
});
