// Post-merge validation: a clean merge that fails `hledger check` is not
// uploaded; it comes back in `invalid` and the vault is marked conflicted.

import { describe, expect, it, vi } from 'vitest';
import type { ValidateHook } from '$lib/sync/engine';
import { Device, FakeProvider } from './helpers/sync-fakes';

/** A toy "hledger check": every transaction's amounts must sum to zero. */
const balanced: ValidateHook = async (files) => {
  const errors: { path: string; message: string }[] = [];
  for (const [path, text] of Object.entries(files)) {
    for (const block of text.split(/\n\s*\n/)) {
      const amounts = [...block.matchAll(/ {2,}(-?\d+)\s*$/gm)].map((m) => Number(m[1]));
      const sum = amounts.reduce((a, b) => a + b, 0);
      if (amounts.length && sum !== 0)
        errors.push({ path, message: `could not balance this transaction (off by ${sum})` });
    }
  }
  return errors;
};

const BASE = `2026-01-01 rent
    expenses:rent    500
    assets:bank     -500
`;

describe('VaultSyncEngine: post-merge validation', () => {
  async function diverge(validate: ValidateHook) {
    const remote = new FakeProvider();
    remote.put('main.journal', BASE);
    const phone = new Device(remote, { validate });
    const laptop = new Device(remote);
    await phone.sync();
    await laptop.sync();
    // Each side alone balances; merged line by line the transaction does not.
    await laptop.edit('main.journal', BASE.replace('500\n', '600\n'));
    await laptop.sync();
    await phone.edit('main.journal', BASE.replace('-500', '-400'));
    return { remote, phone, laptop };
  }

  it('does not upload an invalid clean merge; returns it in invalid and marks the vault conflicted', async () => {
    const validate = vi.fn(balanced);
    const { remote, phone } = await diverge(validate);
    const writes = remote.writes;
    const r = await phone.sync();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(r.conflicts).toEqual([]);
    expect(r.invalid).toEqual([
      { path: 'main.journal', message: 'could not balance this transaction (off by 200)' },
    ]);
    expect(r.pushed).toEqual([]);
    expect(remote.writes).toBe(writes);
    expect(remote.text('main.journal')).toBe(BASE.replace('500\n', '600\n'));
    // The merge is kept locally (so the person can fix it), still pending.
    const merged = await phone.text('main.journal');
    expect(merged).toContain('expenses:rent    600');
    expect(merged).toContain('assets:bank     -400');
    expect(await phone.pending()).toEqual(['main.journal']);
    expect(phone.vault.conflicted).toBe(true);
    expect((await phone.store.getVault('v1'))?.conflicted).toBe(true);
  });

  it('keeps holding uploads while the vault stays invalid, then uploads once fixed', async () => {
    const { remote, phone, laptop } = await diverge(balanced);
    await phone.sync();
    // Another edit, still invalid: nothing goes up.
    await phone.edit('other.journal', '2026-02-01 x\n    a  1\n    b  -1\n');
    const again = await phone.sync();
    expect(again.invalid).toHaveLength(1);
    expect(again.pushed).toEqual([]);
    expect(remote.text('other.journal')).toBeUndefined();

    // The person fixes the merged transaction.
    await phone.edit(
      'main.journal',
      BASE.replace('500\n', '600\n').replace('-500', '-600'),
    );
    const fixed = await phone.sync();
    expect(fixed.invalid).toEqual([]);
    expect(fixed.pushed).toEqual(['main.journal', 'other.journal']);
    expect(phone.vault.conflicted).toBe(false);
    expect((await phone.store.getVault('v1'))?.conflicted).toBe(false);
    await laptop.sync();
    expect(await laptop.text('main.journal')).toContain('assets:bank     -600');
  });

  it('uploads a merge that validates', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', `${BASE}\n2026-01-02 food\n    expenses:food  5\n    assets:bank  -5\n`);
    const phone = new Device(remote, { validate: vi.fn(balanced) });
    const laptop = new Device(remote);
    await phone.sync();
    await laptop.sync();
    await laptop.edit('main.journal', (await laptop.text('main.journal'))!.replace('rent', 'Rent'));
    await laptop.sync();
    await phone.edit('main.journal', (await phone.text('main.journal'))!.replace('food\n', 'Food\n'));
    const r = await phone.sync();
    expect(r.invalid).toEqual([]);
    expect(r.pushed).toEqual(['main.journal']);
    expect(remote.text('main.journal')).toContain('Rent');
    expect(remote.text('main.journal')).toContain('Food');
    expect(phone.vault.conflicted).toBeFalsy();
  });

  it('does not validate when no merge happened', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', BASE);
    const validate = vi.fn(balanced);
    const dev = new Device(remote, { validate });
    await dev.sync();
    await dev.edit('main.journal', `${BASE}\n2026-01-02 x\n    a  1\n    b  -1\n`);
    await dev.sync();
    remote.put('main.journal', BASE);
    await dev.sync();
    expect(validate).not.toHaveBeenCalled();
  });

  it('passes the whole would-be vault to validate', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', 'include sub.journal\n\na\nb\nc\n');
    remote.put('sub.journal', 'sub\n');
    const seen: Record<string, string>[] = [];
    const dev = new Device(remote, {
      validate: async (files, vault) => {
        expect(vault.rootFile).toBe('main.journal');
        seen.push(files);
        return [];
      },
    });
    await dev.sync();
    await dev.edit('main.journal', 'include sub.journal\n\nA\nb\nc\n');
    remote.put('main.journal', 'include sub.journal\n\na\nb\nC\n');
    remote.put('sub.journal', 'sub2\n');
    await dev.sync();
    expect(seen).toEqual([
      { 'main.journal': 'include sub.journal\n\nA\nb\nC\n', 'sub.journal': 'sub2\n' },
    ]);
  });
});
