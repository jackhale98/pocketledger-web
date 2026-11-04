// Syntactic checks on a draft: anything that would change the structure of
// the file (a line break in a one-line field, an account that swallows its
// amount). Balancing and other accounting checks are hledger's job.

import type { TxnDraft } from '../../contracts/writer';
import { DATE_RE } from '../locate';

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftError';
  }
}

const LINE_BREAK = /[\r\n]/;

/** Problems with a draft, as user-facing messages; [] when it can be written. */
export function validateDraft(d: TxnDraft): string[] {
  const errs: string[] = [];
  if (!DATE_RE.test(d.date.trim())) errs.push(`Invalid date "${d.date}"`);
  if (d.date2?.trim() && !DATE_RE.test(d.date2.trim())) errs.push(`Invalid secondary date "${d.date2}"`);
  if (LINE_BREAK.test(d.description)) errs.push('The description must not contain line breaks');
  if (d.description.includes(';')) errs.push("The description must not contain ';' (use the comment)");
  if (d.code !== undefined && (LINE_BREAK.test(d.code) || d.code.includes(')'))) errs.push("The code must not contain ')' or line breaks");
  d.postings.forEach((p, i) => {
    const n = `Posting ${i + 1}`;
    const a = p.account.trim();
    if (!a) errs.push(`${n}: the account is empty`);
    if (LINE_BREAK.test(p.account) || /\t| {2}/.test(a)) errs.push(`${n}: the account must not contain tabs, double spaces or line breaks`);
    if (a.includes(';')) errs.push(`${n}: the account must not contain ';'`);
    if (/^[([]/.test(a) || /^[*!]\s/.test(a)) errs.push(`${n}: write virtual postings and statuses with 'type' and 'status', not in the account`);
    for (const [field, value] of [
      ['amount', p.amount],
      ['cost', p.cost],
      ['assertion', p.assertion],
    ] as const) {
      if (value !== undefined && (LINE_BREAK.test(value) || value.includes(';'))) errs.push(`${n}: the ${field} must not contain ';' or line breaks`);
    }
    if (p.commodity !== undefined && (LINE_BREAK.test(p.commodity) || p.commodity.includes('"'))) errs.push(`${n}: the commodity must not contain quotes or line breaks`);
  });
  return errs;
}

export function assertValidDraft(d: TxnDraft): void {
  const errs = validateDraft(d);
  if (errs.length) throw new DraftError(errs.join('; '));
}
