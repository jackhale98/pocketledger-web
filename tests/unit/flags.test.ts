import { describe, expect, it } from 'vitest';
import { confFlags, journalFlags } from '../../src/lib/vault/flags';
import { makeSnapshot } from '../../src/lib/vault';
import { hasWasm, makeEngine } from '../helpers/engine';

describe('journal flags', () => {
  it('adds --auto when a journal has auto-posting rules', () => {
    expect(journalFlags({ 'main.journal': '= expenses:food\n    (budget:food)  *-1\n' })).toEqual(['--auto']);
    expect(journalFlags({ 'main.journal': '2026-01-01 x\n    a  $1 = $1\n    b\n' })).toEqual([]);
  });
  it('takes only allow-listed general options from hledger.conf', () => {
    const conf = '# my defaults\n--auto --infer-market-prices\n--alias checking=assets:bank:checking\n-V\n--tree\n\n[balance]\n--infer-costs\n';
    expect(confFlags(conf)).toEqual(['--auto', '--infer-market-prices', '--alias=checking=assets:bank:checking']);
  });
  it('puts flags on the snapshot and in its revision', () => {
    const a = makeSnapshot({ 'main.journal': '2026-01-01 x\n    a  1\n    b\n' }, 'main.journal');
    const b = makeSnapshot({ 'main.journal': '2026-01-01 x\n    a  1\n    b\n', 'hledger.conf': '--auto\n' }, 'main.journal');
    expect(a.flags).toBeUndefined();
    expect(b.flags).toEqual(['--auto']);
    expect(a.revision).not.toBe(b.revision);
    expect(Object.keys(b.files)).toEqual(['main.journal']);
  });
});

describe.skipIf(!hasWasm)('auto postings reach every report', () => {
  it('applies = rules through the snapshot flags', async () => {
    const e = await makeEngine();
    const files = { 'main.journal': '= expenses:groceries\n    (budget:food)  *-1\n\n2026-01-05 Shop\n    expenses:groceries  $50\n    assets:cash\n' };
    await e.load(makeSnapshot(files, 'main.journal'));
    const bal = await e.balance();
    expect(bal.rows.map((r) => r.account)).toContain('budget:food');
    const txns = await e.transactions();
    expect(txns[0]!.postings.some((p) => p.account === 'budget:food' && p.generated)).toBe(true);
  });
});
