// Render periodic rules in a file's style. Posting and comment lines are the
// writer's own rendering (indent, amount column, commodity styles); only the
// `~` header line is produced here.

import type { JournalStyle } from '../../contracts/writer';
import { commentLines } from '../writer/format';
import { formatTxn, validateDraft } from '../writer';
import { normalizePeriod, STAND_IN_DATE, STAND_IN_DESC, type RuleDraft } from './parse';

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}

/** `~ PERIOD[  DESCRIPTION][  ; comment]`. With `tail`, that verbatim text replaces the comment part. */
export function formatRuleHeader(d: RuleDraft, tail?: string): string {
  let s = `~ ${normalizePeriod(d.period)}`;
  const desc = d.description.trim();
  if (desc) s += `  ${desc}`;
  if (tail !== undefined) return s + tail;
  const c = commentLines(d.comment)[0];
  if (c) s += `  ; ${c}`;
  return s;
}

/** Render a rule (no trailing EOL) in a style. */
export function formatRule(d: RuleDraft, style: JournalStyle): string {
  const body = formatTxn({ date: STAND_IN_DATE, description: STAND_IN_DESC, ...(d.comment !== undefined ? { comment: d.comment } : {}), postings: d.postings }, style);
  const lines = body.split(style.eol);
  lines[0] = formatRuleHeader(d);
  return lines.join(style.eol);
}

const LINE_BREAK = /[\r\n]/;

/** Problems with the header fields only (period, description). */
export function validateRuleHeader(d: Pick<RuleDraft, 'period' | 'description'>): string[] {
  const errs: string[] = [];
  const p = normalizePeriod(d.period);
  if (!p) errs.push('Enter a period, e.g. monthly');
  if (LINE_BREAK.test(d.period) || d.period.includes(';')) errs.push("The period must not contain ';' or line breaks");
  if (LINE_BREAK.test(d.description)) errs.push('The description must not contain line breaks');
  if (d.description.includes(';')) errs.push("The description must not contain ';' (use the comment)");
  return errs;
}

/** Problems with a rule draft, as user-facing messages; [] when it can be written. Balancing is hledger's job. */
export function validateRule(d: RuleDraft): string[] {
  const errs = validateRuleHeader(d);
  if (d.postings.length === 0) errs.push('A recurring transaction needs at least one posting');
  const postingErrs = validateDraft({ date: STAND_IN_DATE, description: '', postings: d.postings });
  return [...errs, ...postingErrs];
}

export function assertValidRule(d: RuleDraft): void {
  const errs = validateRule(d);
  if (errs.length) throw new RuleError(errs.join('; '));
}
