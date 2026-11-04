import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VaultSnapshot } from '../../src/lib/contracts/engine';
import { StalePatchError } from '../../src/lib/contracts/writer';
import { apply } from '../../src/lib/journal/writer';
import {
  composePeriod,
  defaultRuleFile,
  findRules,
  findRuleSpans,
  formatRule,
  parseRuleHeader,
  planAddRule,
  planAddRuleText,
  planDeleteRule,
  planEditRule,
  planReplaceRuleText,
  ruleCheckWindow,
  ruleFromText,
  ruleStyle,
  rulesInFile,
  RuleError,
  splitPeriod,
  type PeriodicRule,
  type RuleDraft,
} from '../../src/lib/journal/periodic';
import { loadVaults, VARIANTS, variantVault } from '../fidelity/helpers';
import { hasWasm, makeEngine, snapshot } from '../helpers/engine';

const vault = (text: string, extra: Record<string, string> = {}): VaultSnapshot => ({ rootFile: 'main.journal', files: { 'main.journal': text, ...extra }, revision: 'r' });
const run = (s: VaultSnapshot, patches: ReturnType<typeof planAddRule>, file = 'main.journal') => apply(s.files, patches)[file]!;
const lines = (t: string) => t.replace(/^﻿/, '').split(/\r?\n/);
/** 1-based numbers of lines that differ between a and b (same line count assumed). */
const changedLines = (a: string, b: string) => {
  const x = lines(a);
  const y = lines(b);
  expect(y.length).toBe(x.length);
  return x.flatMap((l, i) => (l === y[i] ? [] : [i + 1]));
};
const draftOf = (r: PeriodicRule): RuleDraft => ({ period: r.period, description: r.description, ...(r.comment !== undefined ? { comment: r.comment } : {}), postings: r.postings.map((p) => ({ ...p })) });

const J = `; Budget and recurring items
account assets:checking  ; type: C

~ monthly from 2026-01-01  Rent  ; housing
    expenses:rent            $1,650.00
    assets:checking

~ every 2 weeks  Salary
    ; paid on Fridays
    assets:checking          $2,100.00
    income:salary

2026-10-01 * Landlord
    expenses:rent            $1,650.00
    assets:checking
`;

describe('locate and parse', () => {
  it('finds rules, not transactions, and skips comment blocks', () => {
    const t = '~ monthly\n    a  $1\n    b\n\ncomment\n~ weekly\n    a  $1\nend comment\n2024-01-01 x\n    a  $1\n    b\n~weekly  Tight\n    a  $2\n    b\n';
    expect(findRuleSpans(t, 'f')).toEqual([
      { file: 'f', startLine: 1, endLine: 3 },
      { file: 'f', startLine: 12, endLine: 14 },
    ]);
  });

  it('reads the header: period ends at two spaces, comment after ;', () => {
    expect(parseRuleHeader('~ monthly from 2026-01-01  Rent  ; housing')).toMatchObject({ period: 'monthly from 2026-01-01', description: 'Rent', comment: 'housing', tail: '  ; housing' });
    expect(parseRuleHeader('~ every 2 weeks')).toMatchObject({ period: 'every 2 weeks', description: '', comment: null, tail: '' });
    expect(parseRuleHeader('~monthly\tfrom 2026  X')).toMatchObject({ period: 'monthly\tfrom 2026', description: 'X' });
    expect(parseRuleHeader('2024-01-01 x')).toBeNull();
  });

  it('parses rules into drafts with spans and exact text', () => {
    const rules = rulesInFile(J, 'main.journal');
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({
      period: 'monthly from 2026-01-01',
      description: 'Rent',
      comment: 'housing',
      span: { file: 'main.journal', startLine: 4, endLine: 6 },
      postings: [{ account: 'expenses:rent', amount: '1,650.00', commodity: '$' }, { account: 'assets:checking' }],
    });
    expect(rules[0]!.text).toBe('~ monthly from 2026-01-01  Rent  ; housing\n    expenses:rent            $1,650.00\n    assets:checking');
    expect(rules[1]).toMatchObject({ period: 'every 2 weeks', description: 'Salary', comment: '\npaid on Fridays', span: { startLine: 8, endLine: 11 } });
    expect(ruleFromText(rules[1]!.text)).toEqual(draftOf(rules[1]!));
  });

  it('finds the rules in the fixtures', () => {
    const ks = readFileSync(resolve('tests/fixtures/writer/kitchen-sink.journal'), 'utf8');
    expect(findRules({ 'k.journal': ks }).map((r) => [r.period, r.description, r.postings.length])).toEqual([['monthly', 'Budget', 2]]);
    const demo = readFileSync(resolve('src/demo/vault/budget.journal'), 'utf8');
    const [r] = findRules({ 'budget.journal': demo });
    expect(r!.period).toBe('monthly from 2026-05');
    expect(r!.postings.at(-1)).toEqual({ account: 'assets:checking' });
  });
});

describe('period expressions', () => {
  it('splits and recomposes interval/from/to', () => {
    expect(splitPeriod('monthly from 2026-01 to 2026-12-31')).toEqual({ interval: 'monthly', from: '2026-01', to: '2026-12-31' });
    expect(splitPeriod('every 2 weeks  from 2026-01-02')).toEqual({ interval: 'every 2 weeks', from: '2026-01-02', to: '' });
    expect(splitPeriod('every 15th day of month')).toEqual({ interval: 'every 15th day of month', from: '', to: '' });
    expect(splitPeriod('monthly in 2026')).toEqual({ interval: 'monthly in 2026', from: '', to: '' });
    expect(splitPeriod('from 2026 to 2027 monthly').interval).toBe('from 2026 to 2027 monthly');
    expect(composePeriod({ interval: ' weekly ', from: '2026-01-05', to: '' })).toBe('weekly from 2026-01-05');
  });

  it('picks a check window that covers an occurrence', () => {
    expect(ruleCheckWindow('monthly', '2026-11-04')).toBe('2026-11-04..2027-12-04');
    expect(ruleCheckWindow('yearly from 2030', '2026-11-04')).toBe('2030-01-01..2031-02-01');
    expect(ruleCheckWindow('monthly to 2020-06', '2026-11-04')).toBe('2019-05-01..2020-06-01');
    expect(ruleCheckWindow('weekly from 2026-01-05 to 2026-03-01', '2026-11-04')).toBe('2026-01-05..2026-03-01');
  });
});

describe('format', () => {
  it('renders in the file style (indent, amount column, commodity style)', () => {
    const style = ruleStyle(vault(J), 'main.journal');
    const text = formatRule({ period: 'monthly', description: 'Gym', comment: 'health', postings: [{ account: 'expenses:gym', amount: '45', commodity: '$' }, { account: 'assets:checking' }] }, style);
    expect(text).toBe('~ monthly  Gym  ; health\n    expenses:gym                $45.00\n    assets:checking');
    expect(formatRule({ period: 'weekly', description: '', postings: [{ account: 'a', amount: '1', commodity: '$' }, { account: 'b' }] }, style).split('\n')[0]).toBe('~ weekly');
  });
});

describe('plan', () => {
  const s = vault(J);
  const rules = () => findRules(s.files);

  it('no-op edit and no-op text replace are []', () => {
    for (const r of rules()) {
      expect(planEditRule(s, r, draftOf(r))).toEqual([]);
      expect(planReplaceRuleText(s, r, r.text)).toEqual([]);
    }
  });

  it('no-op edits are [] for every rule of every fixture and byte variant', () => {
    let n = 0;
    for (const base of loadVaults()) {
      for (const variant of VARIANTS) {
        const v = variantVault(base, variant);
        const snap: VaultSnapshot = { rootFile: v.rootFile, files: v.files, revision: 'v' };
        for (const r of findRules(v.files)) {
          n++;
          expect(planEditRule(snap, r, draftOf(r)), v.name).toEqual([]);
          expect(planReplaceRuleText(snap, r, r.text), v.name).toEqual([]);
        }
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it('edits of every fixture rule change only lines inside its span, keeping EOL and BOM', () => {
    for (const base of loadVaults()) {
      for (const variant of VARIANTS) {
        const v = variantVault(base, variant);
        const snap: VaultSnapshot = { rootFile: v.rootFile, files: v.files, revision: 'v' };
        for (const r of findRules(v.files)) {
          const before = v.files[r.span.file]!;
          const d = draftOf(r);
          d.description = `${d.description} edited`.trim();
          const i = d.postings.findIndex((p) => p.amount);
          if (i >= 0) d.postings[i]!.amount = '123.45';
          const after = apply(v.files, planEditRule(snap, r, d))[r.span.file]!;
          const changed = changedLines(before, after);
          expect(changed.length, v.name).toBe(i >= 0 ? 2 : 1);
          for (const n of changed) expect(n >= r.span.startLine && n <= r.span.endLine, v.name).toBe(true);
          expect(after.startsWith('\uFEFF'), v.name).toBe(before.startsWith('\uFEFF'));
          expect(/\r\n/.test(after), v.name).toBe(/\r\n/.test(before));
          expect(after.endsWith('\n'), v.name).toBe(before.endsWith('\n'));
          const [again] = findRules({ [r.span.file]: after }).filter((x) => x.span.startLine === r.span.startLine);
          expect(again!.description, v.name).toBe(d.description);
        }
      }
    }
  });

  it('an amount edit changes exactly that posting line and keeps the alignment', () => {
    const r = rules()[0]!;
    const d = draftOf(r);
    d.postings[0]!.amount = '1700';
    const out = run(s, planEditRule(s, r, d));
    expect(changedLines(J, out)).toEqual([5]);
    expect(lines(out)[4]).toBe('    expenses:rent            $1,700.00');
  });

  it('a description edit changes only the header and keeps the comment tail', () => {
    const r = rules()[0]!;
    const out = run(s, planEditRule(s, r, { ...draftOf(r), description: 'Apartment rent' }));
    expect(changedLines(J, out)).toEqual([4]);
    expect(lines(out)[3]).toBe('~ monthly from 2026-01-01  Apartment rent  ; housing');
  });

  it('a period edit keeps postings and comment lines byte-identical', () => {
    const r = rules()[1]!;
    const out = run(s, planEditRule(s, r, { ...draftOf(r), period: 'biweekly from 2026-01-02' }));
    expect(changedLines(J, out)).toEqual([8]);
    expect(lines(out)[7]).toBe('~ biweekly from 2026-01-02  Salary');
  });

  it('adding a posting touches only the rule', () => {
    const r = rules()[0]!;
    const d = draftOf(r);
    d.postings.splice(1, 0, { account: 'expenses:parking', amount: '50', commodity: '$' });
    const out = run(s, planEditRule(s, r, d));
    const a = lines(J);
    const b = lines(out);
    expect(b.length).toBe(a.length + 1);
    expect(b.slice(0, 5)).toEqual(a.slice(0, 5));
    expect(b[5]).toBe('    expenses:parking            $50.00');
    expect(b.slice(6)).toEqual(a.slice(5));
  });

  it('delete removes one separator, leaving no double blank line', () => {
    for (const r of rules()) {
      const out = run(s, planDeleteRule(s, r));
      expect(out).not.toMatch(/\n\s*\n\s*\n/);
      expect(findRules({ 'main.journal': out })).toHaveLength(1);
    }
    // Last thing in a file: the blank line before goes.
    const t = vault('2024-01-01 x\n    a  $1\n    b\n\n~ monthly\n    a  $1\n    b\n');
    expect(run(t, planDeleteRule(t, findRules(t.files)[0]!))).toBe('2024-01-01 x\n    a  $1\n    b\n');
  });

  it('adds after the last rule of the file, with blank lines around it', () => {
    const add: RuleDraft = { period: 'yearly', description: 'Insurance', postings: [{ account: 'expenses:insurance', amount: '600', commodity: '$' }, { account: 'assets:checking' }] };
    const out = run(s, planAddRule(s, add));
    const b = lines(out);
    expect(b.slice(11, 16)).toEqual(['', '~ yearly  Insurance', '    expenses:insurance         $600.00', '    assets:checking', '']);
    expect(b.slice(16)).toEqual(lines(J).slice(12));
    expect(findRules({ 'main.journal': out }).map((r) => r.description)).toEqual(['Rent', 'Salary', 'Insurance']);
  });

  it('aligns new rules like the existing ones in a rules-only file', () => {
    const demo = readFileSync(resolve('src/demo/vault/budget.journal'), 'utf8');
    const d = vault('include budget.journal\n', { 'budget.journal': demo });
    const out = run(d, planAddRule(d, { period: 'yearly', description: 'Insurance', postings: [{ account: 'expenses:insurance', amount: '600', commodity: '$' }, { account: 'assets:checking' }] }, { targetFile: 'budget.journal' }), 'budget.journal');
    expect(out).toBe(demo + '\n~ yearly  Insurance\n    expenses:insurance          $600.00\n    assets:checking\n');
  });

  it('appends to a file without rules (keeping its final-newline state) and to an empty file', () => {
    const add: RuleDraft = { period: 'monthly', description: 'Gym', postings: [{ account: 'expenses:gym', amount: '45', commodity: '$' }, { account: 'assets:checking' }] };
    const t = vault('2024-01-01 x\n    a  $1\n    b');
    expect(run(t, planAddRule(t, add))).toBe('2024-01-01 x\n    a  $1\n    b\n\n~ monthly  Gym\n    expenses:gym  $45\n    assets:checking');
    const e = vault('', { 'rules.journal': '' });
    expect(run(e, planAddRule(e, add, { targetFile: 'rules.journal' }), 'rules.journal')).toBe('~ monthly  Gym\n    expenses:gym  $45\n    assets:checking\n');
  });

  it('preserves CRLF and BOM, and everything outside the span', () => {
    const crlf = '﻿' + J.replace(/\n/g, '\r\n');
    const c = vault(crlf);
    const r = findRules(c.files)[0]!;
    const d = draftOf(r);
    d.postings[0]!.amount = '1700';
    const out = run(c, planEditRule(c, r, d));
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).toBe(crlf.replace('$1,650.00\r\n    assets:checking\r\n\r\n~ every', '$1,700.00\r\n    assets:checking\r\n\r\n~ every'));
    const added = run(c, planAddRule(c, { period: 'weekly', description: 'Coffee', postings: [{ account: 'expenses:coffee', amount: '20', commodity: '$' }, { account: 'assets:checking' }] }));
    expect(added.startsWith('﻿')).toBe(true);
    expect(added).not.toMatch(/[^\r]\n/);
    const deleted = run(c, planDeleteRule(c, r));
    expect(deleted.startsWith('﻿')).toBe(true);
    expect(deleted).not.toMatch(/[^\r]\n/);
    expect(deleted.slice(1).replace(/\r\n/g, '\n')).toBe(J.replace('~ monthly from 2026-01-01  Rent  ; housing\n    expenses:rent            $1,650.00\n    assets:checking\n\n', ''));
  });

  it('text mode: replace, add, and refuse text that is not a rule', () => {
    const r = rules()[0]!;
    const out = run(s, planReplaceRuleText(s, r, '\n~ monthly  Rent\n    expenses:rent  $1,700\n    assets:checking\n\n'));
    expect(lines(out).slice(3, 7)).toEqual(['~ monthly  Rent', '    expenses:rent  $1,700', '    assets:checking', '']);
    expect(() => planReplaceRuleText(s, r, '2026-01-01 Rent\n    a  $1\n    b')).toThrow(RuleError);
    expect(run(s, planReplaceRuleText(s, r, '  \n'))).toBe(run(s, planDeleteRule(s, r)));
    const added = run(s, planAddRuleText(s, '~ weekly  Coffee\r\n    expenses:coffee  $20\r\n    assets:checking'));
    expect(findRules({ 'main.journal': added }).map((x) => x.description)).toEqual(['Rent', 'Salary', 'Coffee']);
    expect(added).not.toContain('\r');
  });

  it('refuses stale rules and invalid drafts', () => {
    const r = rules()[0]!;
    const moved = vault('\n' + J);
    expect(() => planEditRule(moved, r, draftOf(r))).toThrow(StalePatchError);
    expect(() => planDeleteRule(vault(J.replace('$1,650.00\n    assets:checking\n\n~ every', '$1,600.00\n    assets:checking\n\n~ every')), r)).toThrow(StalePatchError);
    expect(() => planEditRule(s, r, { ...draftOf(r), description: 'a;b' })).toThrow(RuleError);
    expect(() => planAddRule(s, { period: ' ', description: 'x', postings: [{ account: 'a' }] })).toThrow(RuleError);
    expect(() => planAddRule(s, { period: 'monthly', description: 'x', postings: [] })).toThrow(RuleError);
  });

  it('chooses a file that already has rules for new ones', () => {
    expect(defaultRuleFile({ rootFile: 'main.journal', files: { 'main.journal': 'include b.journal\n', 'b.journal': '~ monthly\n    a  $1\n    b\n' } })).toBe('b.journal');
    expect(defaultRuleFile({ rootFile: 'main.journal', files: { 'main.journal': 'include b.journal\n', 'b.journal': '' } })).toBe('main.journal');
  });
});

describe.skipIf(!hasWasm)('periodic rules with hledger', () => {
  const BASE = `account assets:checking  ; type: C

2026-09-01 * Opening
    assets:checking   $1,000.00
    equity:opening
`;

  it('an added rule makes hledger generate forecast transactions and a projection', async () => {
    const e = await makeEngine();
    const s0 = snapshot({ 'main.journal': BASE });
    const patches = planAddRule(s0, { period: 'monthly from 2026-01-01', description: 'Rent', postings: [{ account: 'expenses:rent', amount: '400', commodity: '$' }, { account: 'assets:checking' }] });
    const files = apply(s0.files, patches);
    const s1 = snapshot(files);
    expect(await e.check(s1)).toEqual([]);
    expect(await e.check(s1, ['-I', `--forecast=${ruleCheckWindow('monthly from 2026-01-01', '2026-11-04')}`])).toEqual([]);
    expect((await e.load(s1)).ok).toBe(true);

    const txns = await e.transactions({ forecast: '2026-11-04..2027-03-01', period: { begin: '2026-11-04', end: '2027-03-01' } });
    const gen = txns.filter((t) => t.generated);
    expect(gen.map((t) => [t.date, t.description, t.source])).toEqual([
      ['2026-12-01', 'Rent', undefined],
      ['2027-01-01', 'Rent', undefined],
      ['2027-02-01', 'Rent', undefined],
    ]);
    expect(gen[0]!.postings.find((p) => p.account === 'assets:checking')!.amount[0]!.quantity).toBe('-400.00');

    const proj = await e.periodicBalance({
      query: ['acct:^assets:checking(:|$)'],
      period: { begin: '2026-09-01', end: '2027-03-01', interval: 'monthly' },
      accumulation: 'historical',
      forecast: '2026-11-04..2027-03-01',
    });
    expect(proj.totals.amounts.map((m) => m[0]?.quantity ?? '0')).toEqual(['1000.00', '1000.00', '1000.00', '600.00', '200.00', '-200.00']);

    // The running balance (register -H) shows the lowest point and its date.
    const reg = await e.register('assets:checking', { period: { begin: '2026-11-04', end: '2027-03-01' }, accumulation: 'historical', forecast: '2026-11-04..2027-03-01' });
    expect(reg.map((r) => [r.date, r.balance[0]!.quantity])).toEqual([
      ['2026-12-01', '600.00'],
      ['2027-01-01', '200.00'],
      ['2027-02-01', '-200.00'],
    ]);

    // Editing the rule changes the projection.
    const [rule] = findRules(files);
    const d = draftOf(rule!);
    d.postings[0]!.amount = '100';
    const s2 = snapshot(apply(files, planEditRule(s1, rule!, d)));
    expect((await e.load(s2)).ok).toBe(true);
    const proj2 = await e.periodicBalance({ query: ['acct:^assets:checking(:|$)'], period: { begin: '2026-09-01', end: '2027-03-01', interval: 'monthly' }, accumulation: 'historical', forecast: '2026-11-04..2027-03-01' });
    expect(proj2.totals.amounts.at(-1)![0]!.quantity).toBe('700.00');
  });

  it('an invalid rule is refused by check', async () => {
    const e = await makeEngine();
    const s0 = snapshot({ 'main.journal': BASE });
    // A period hledger cannot read: a parse error at the rule's line.
    const bad = snapshot(apply(s0.files, planAddRuleText(s0, '~ every blursday  Bad\n    expenses:x  $1\n    assets:checking')));
    const errs = await e.check(bad);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ kind: 'parse', file: 'main.journal', line: 7 });
    // An unbalanced rule only fails once it generates something: check in its window.
    const unbalanced = snapshot(
      apply(s0.files, planAddRule(s0, { period: 'monthly', description: 'Unbalanced', postings: [{ account: 'expenses:x', amount: '1', commodity: '$' }, { account: 'assets:checking', amount: '2', commodity: '$' }] })),
    );
    expect(await e.check(unbalanced)).toEqual([]);
    const errs2 = await e.check(unbalanced, ['-I', `--forecast=${ruleCheckWindow('monthly', '2026-11-04')}`]);
    expect(errs2).toHaveLength(1);
    expect(errs2[0]!.message).toContain('unbalanced');
    expect(errs2[0]).toMatchObject({ file: 'main.journal', line: 7 });
  });
});
