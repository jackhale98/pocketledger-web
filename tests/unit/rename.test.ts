import { describe, expect, it } from 'vitest';
import { accountNameProblem, planRenameAccount, renamedAccount } from '../../src/lib/journal/rename';
import { hasWasm, makeEngine, snapshot } from '../helpers/engine';
import type { BalanceReport } from '../../src/lib/contracts/engine';

const J = [
  '; assets:cash is mentioned in a comment',
  'account assets:cash               ; type: C',
  'account assets:cash:wallet',
  'account assets:cash2',
  'account liabilities:credit card   ; type: L',
  '',
  '2026-01-01 * Opening assets:cash balance  ; note assets:cash',
  '    ; assets:cash in an indented comment',
  '    assets:cash                  $100.00 = $100.00',
  '    assets:cash:wallet            $20.00',
  '    assets:cash2                   $5.00',
  '    (assets:cash)                  $1.00',
  '    [assets:cash:wallet]          $-1.00',
  '    [liabilities:credit card]      $1.00',
  '    (liabilities:credit card)      $1.00',
  '    equity:opening',
  '',
  '2026-01-02 ! Coffee',
  '    expenses:coffee                $3.00  ; paid from assets:cash',
  '    ! assets:cash',
  '',
  '2026-01-03 Card',
  '    expenses:food                 $10.00',
  '    liabilities:credit card',
  '',
].join('\n');

describe('planRenameAccount', () => {
  it('renames an account and its subaccounts, nothing else', () => {
    const { files, changes } = planRenameAccount({ 'main.journal': J }, 'assets:cash', 'assets:pocket');
    const out = files['main.journal']!.split('\n');
    const before = J.split('\n');
    expect(changes.map((c) => c.line)).toEqual([2, 3, 9, 10, 12, 13, 20]);
    for (let i = 0; i < before.length; i++) if (!changes.some((c) => c.line === i + 1)) expect(out[i]).toBe(before[i]);
    expect(out[1]).toBe('account assets:pocket             ; type: C');
    expect(out[2]).toBe('account assets:pocket:wallet');
    expect(out[3]).toBe('account assets:cash2');
    expect(out[8]).toBe('    assets:pocket                $100.00 = $100.00');
    expect(out[9]).toBe('    assets:pocket:wallet          $20.00');
    expect(out[10]).toBe('    assets:cash2                   $5.00');
    expect(out[11]).toBe('    (assets:pocket)                $1.00');
    expect(out[12]).toBe('    [assets:pocket:wallet]        $-1.00');
    expect(out[19]).toBe('    ! assets:pocket');
    // Header with the name in the description and comment, comment lines: untouched.
    expect(out[0]).toBe(before[0]);
    expect(out[6]).toBe(before[6]);
    expect(out[7]).toBe(before[7]);
    expect(out[18]).toBe(before[18]);
  });

  it('keeps the amount end column when the name gets longer or shorter, else two spaces', () => {
    const t = '2026-01-01 x\n    a:b                $1.00\n    c\n';
    const longer = planRenameAccount({ 'm.journal': t }, 'a:b', 'a:bbbbbb').files['m.journal']!;
    expect(longer.split('\n')[1]).toBe('    a:bbbbbb           $1.00');
    const shorter = planRenameAccount({ 'm.journal': t }, 'a:b', 'z').files['m.journal']!;
    expect(shorter.split('\n')[1]).toBe('    z                  $1.00');
    const tooLong = planRenameAccount({ 'm.journal': t }, 'a:b', 'a:a-very-long-account-name').files['m.journal']!;
    expect(tooLong.split('\n')[1]).toBe('    a:a-very-long-account-name  $1.00');
    // Tabs are kept as written.
    const tabs = planRenameAccount({ 'm.journal': '2026-01-01 x\n\ta:b\t\t$1.00\n\tc\n' }, 'a:b', 'q').files['m.journal']!;
    expect(tabs).toBe('2026-01-01 x\n\tq\t\t$1.00\n\tc\n');
    // The amount column is measured visually (status mark, brackets).
    const st = planRenameAccount({ 'm.journal': '2026-01-01 x\n    * (a:b)     $1.00\n    c\n' }, 'a:b', 'a:bc').files['m.journal']!;
    expect(st.split('\n')[1]).toBe('    * (a:bc)    $1.00');
  });

  it('handles accounts with spaces, both as source and target', () => {
    const { files, changes } = planRenameAccount({ 'main.journal': J }, 'liabilities:credit card', 'liabilities:visa card');
    const out = files['main.journal']!.split('\n');
    expect(changes.map((c) => c.line)).toEqual([5, 14, 15, 24]);
    expect(out[4]).toBe('account liabilities:visa card     ; type: L');
    expect(out[13]).toBe('    [liabilities:visa card]        $1.00');
    expect(out[14]).toBe('    (liabilities:visa card)        $1.00');
    expect(out[23]).toBe('    liabilities:visa card');
  });

  it('does not match prefixes of other names (assets:cash2) or partial parents', () => {
    expect(renamedAccount('assets:cash2', 'assets:cash', 'x')).toBeNull();
    expect(renamedAccount('assets:cash:a', 'assets:cash', 'x')).toBe('x:a');
    expect(renamedAccount('xassets:cash', 'assets:cash', 'y')).toBeNull();
    const { changes } = planRenameAccount({ 'main.journal': J }, 'assets:cash2', 'assets:jar');
    expect(changes.map((c) => c.line)).toEqual([4, 11]);
    expect(planRenameAccount({ 'main.journal': J }, 'assets:ca', 'assets:x').changes).toEqual([]);
  });

  it('renames in periodic and auto-posting rules, aliases and apply account; not in other directives', () => {
    const t = [
      '~ monthly from 2026-01  assets:cash budget',
      '    expenses:food     $500.00',
      '    assets:cash',
      '',
      '= expenses:food',
      '    (budget:food)     *-1',
      '',
      '= acct:^expenses:food$ desc:expenses:food',
      '    [assets:cash]     *1',
      '',
      '= "acct:expenses:food" not:acct:expenses:food:snacks amt:>10',
      '    (x)  *1',
      '',
      'alias cash = assets:cash',
      'alias /^cash$/ = assets:cash',
      'alias assets:cash = other',
      'apply account assets:cash',
      'commodity $1,000.00',
      '  format $1,000.00',
      'payee assets:cash',
      'tag assets:cash',
      'P 2026-01-01 EUR $1.10',
      '',
    ].join('\n');
    const { files, changes } = planRenameAccount({ 'r.journal': t }, 'expenses:food', 'expenses:groceries');
    const out = files['r.journal']!.split('\n');
    expect(out[0]).toBe(t.split('\n')[0]); // a periodic rule's description is not an account
    expect(out[1]).toBe('    expenses:groceries  $500.00');
    expect(out[4]).toBe('= expenses:groceries');
    expect(out[7]).toBe('= acct:^expenses:groceries$ desc:expenses:food');
    expect(out[10]).toBe('= "acct:expenses:groceries" not:acct:expenses:groceries:snacks amt:>10');
    expect(changes).toHaveLength(4);

    const cash = planRenameAccount({ 'r.journal': t }, 'assets:cash', 'assets:pocket money');
    const o2 = cash.files['r.journal']!.split('\n');
    expect(o2[2]).toBe('    assets:pocket money');
    expect(o2[8]).toBe('    [assets:pocket money]  *1');
    expect(o2[13]).toBe('alias cash = assets:pocket money');
    expect(o2[14]).toBe('alias /^cash$/ = assets:cash'); // regex alias: left alone
    expect(o2[15]).toBe('alias assets:cash = other'); // the alias source is a name as written, not this account
    expect(o2[16]).toBe('apply account assets:pocket money');
    expect(o2.slice(17)).toEqual(t.split('\n').slice(17));

    const rule = planRenameAccount({ 'r.journal': '= assets:cash\n    (x)  *1\n' }, 'assets:cash', 'assets:pocket money').files['r.journal'];
    expect(rule).toBe('= "assets:pocket money"\n    (x)  *1\n');
  });

  it('renames CSV rules account assignments', () => {
    const rules = 'skip 1\nfields date, desc, amount\naccount1 assets:cash\nif coffee\n  account2 expenses:coffee\n';
    const { files } = planRenameAccount({ 'bank.csv.rules': rules, 'bank.csv': 'assets:cash,1\n' }, 'assets:cash', 'assets:wallet');
    expect(files['bank.csv.rules']).toBe(rules.replace('account1 assets:cash', 'account1 assets:wallet'));
    expect(files['bank.csv']).toBe('assets:cash,1\n');
  });

  it('skips comment blocks', () => {
    const t = 'comment\n2026-01-01 x\n    assets:cash  $1\nend comment\n2026-01-01 y\n    assets:cash  $1\n    z\n';
    const { changes } = planRenameAccount({ 'm.journal': t }, 'assets:cash', 'assets:q');
    expect(changes.map((c) => c.line)).toEqual([6]);
  });

  it('preserves CRLF, a BOM, a missing final newline, and leaves untouched files byte-identical', () => {
    const crlf = '﻿' + J.replace(/\n/g, '\r\n');
    const other = '2026-01-01 x\r\n    expenses:food  $1\r\n    equity:x';
    const input = { 'a.journal': crlf, 'b.journal': other, 'c.journal': 'include a.journal' };
    const { files } = planRenameAccount(input, 'assets:cash', 'assets:pocket');
    expect(files['a.journal']!.startsWith('﻿')).toBe(true);
    expect(files['a.journal']!.split('\r\n')).toHaveLength(crlf.split('\r\n').length);
    expect(files['a.journal']!.replace(/[^\n]/g, '').length).toBe(crlf.replace(/[^\n]/g, '').length);
    expect(files['a.journal']!.includes('\r\n    assets:pocket                $100.00')).toBe(true);
    expect(files['b.journal']).toBe(other);
    expect(files['c.journal']).toBe('include a.journal');
    const noFinal = planRenameAccount({ 'm.journal': '2026-01-01 x\n    a  $1\n    assets:cash' }, 'assets:cash', 'q').files['m.journal'];
    expect(noFinal).toBe('2026-01-01 x\n    a  $1\n    q');
  });

  it('refuses invalid target names', () => {
    expect(() => planRenameAccount({}, 'a', 'b  c')).toThrow(/double spaces/);
    expect(() => planRenameAccount({}, 'a', 'b;c')).toThrow(/;/);
    expect(() => planRenameAccount({}, 'a', '')).toThrow(/empty/);
    expect(accountNameProblem('(a)')).not.toBeNull();
    expect(accountNameProblem('a:b c')).toBeNull();
    expect(planRenameAccount({ 'm.journal': J }, 'assets:cash', 'assets:cash').changes).toEqual([]);
  });
});

describe.skipIf(!hasWasm)('planRenameAccount with hledger', () => {
  const flat = (r: BalanceReport) => r.rows.map((x) => `${x.account} ${x.amount.map((a) => `${a.quantity} ${a.commodity}`).join(',')}`);

  it('balances are identical except for the name', async () => {
    const files = {
      'main.journal': J + '\ninclude rules.journal\n',
      'rules.journal': '= expenses:food\n    (budget:food)     *-1\n\n~ monthly from 2026-01\n    expenses:food  $50\n    assets:cash\n',
    };
    const e = await makeEngine();
    const r1 = await e.load({ ...snapshot(files, 'main.journal'), flags: ['--auto'] });
    expect(r1.ok).toBe(true);
    const before = await e.balance({ empty: true });
    const budgetBefore = await e.budget({ period: { begin: '2026-01-01', end: '2026-02-01', interval: 'monthly' } });
    const typesBefore = (await e.accounts()).map((a) => `${a.name}:${a.type}`);

    for (const [from, to] of [
      ['assets:cash', 'assets:pocket money'],
      ['liabilities:credit card', 'liabilities:visa'],
      ['expenses:food', 'expenses:groceries'],
    ] as const) {
      const { files: next } = planRenameAccount(files, from, to);
      const e2 = await makeEngine();
      const r2 = await e2.load({ ...snapshot(next, 'main.journal'), flags: ['--auto'] });
      expect(r2.ok, JSON.stringify(r2)).toBe(true);
      const map = (name: string) => {
        if (name === from) return to;
        if (name.startsWith(from + ':')) return to + name.slice(from.length);
        return name;
      };
      const after = await e2.balance({ empty: true });
      const expected = flat({ ...before, rows: before.rows.map((x) => ({ ...x, account: map(x.account) })) }).sort();
      expect(flat(after).sort()).toEqual(expected);
      expect(after.total).toEqual(before.total);
      const budgetAfter = await e2.budget({ period: { begin: '2026-01-01', end: '2026-02-01', interval: 'monthly' } });
      expect(budgetAfter.rows.map((x) => [x.account, JSON.stringify(x.cells)]).sort()).toEqual(
        budgetBefore.rows.map((x) => [map(x.account), JSON.stringify(x.cells)]).sort(),
      );
      expect((await e2.accounts()).map((a) => `${a.name}:${a.type}`).sort()).toEqual(typesBefore.map((s) => {
        const i = s.lastIndexOf(':');
        return `${map(s.slice(0, i))}${s.slice(i)}`;
      }).sort());
    }
  });
});
