// Plan minimal line patches (the writer's Patch type, applied with
// writer.apply) to add, edit, replace or delete periodic rules.
//
// Editing is the writer's own planEdit: the rule is presented to it as a
// transaction (its `~` header swapped for a stand-in date header, everything
// else as in the file), so unchanged postings and comment lines stay
// byte-identical and changed ones keep their indent, spacing and alignment.
// The header line is kept verbatim unless the period, description or inline
// comment changed.

import type { SourceSpan, Txn, VaultSnapshot } from '../../contracts/engine';
import { StalePatchError, type Patch } from '../../contracts/writer';
import { isBlank, joinLines, rangeText, splitLines, splitText, type Lines } from '../locate';
import { commentLines } from '../writer/format';
import { planEdit, styleForFile, type InferredStyle } from '../writer';
import { assertValidRule, formatRule, formatRuleHeader, RuleError, validateRuleHeader } from './format';
import { normalizePeriod, parseRuleHeader, parseRuleLines, STAND_IN_DATE, STAND_IN_DESC, STAND_IN_HEADER, type PeriodicRule, type RuleDraft } from './parse';
import { findRuleSpans, normalizeRuleSpan } from './spans';

interface LocatedRule {
  file: string;
  lines: Lines;
  startLine: number;
  endLine: number;
}

type RuleRef = Pick<PeriodicRule, 'span'> & { text?: string };

/** Find a rule's lines in the snapshot: the header must still be at its line and (when given) the text unchanged. */
export function locateRule(snapshot: VaultSnapshot, rule: RuleRef): LocatedRule {
  const { file, startLine } = rule.span;
  const text = snapshot.files[file];
  if (text === undefined) throw new StalePatchError(file, startLine);
  const lines = splitLines(text);
  const span = normalizeRuleSpan(lines, rule.span);
  if (!span) throw new StalePatchError(file, startLine);
  if (rule.text !== undefined && rangeText(lines, span.startLine, span.endLine) !== rule.text) throw new StalePatchError(file, startLine);
  return { file, lines, ...span };
}

const firstComment = (c: string | undefined) => commentLines(c)[0] ?? '';

/** The file's lines with every rule header swapped for a stand-in transaction header, so the writer sees rule postings. */
function swapRuleHeaders(l: Lines, file: string): Lines {
  const out: Lines = { bom: l.bom, lines: [...l.lines], eols: [...l.eols] };
  for (const s of findRuleSpans(l, file)) out.lines[s.startLine - 1] = STAND_IN_HEADER + parseRuleHeader(l.lines[s.startLine - 1]!)!.tail;
  return out;
}

/** Files as the writer should see them to write rules: rule headers swapped in `file` and the root file. */
function withSwappedRules(snapshot: VaultSnapshot, file: string): VaultSnapshot {
  const files = { ...snapshot.files };
  for (const f of new Set([file, snapshot.rootFile])) if (files[f] !== undefined) files[f] = joinLines(swapRuleHeaders(splitLines(files[f]!), f));
  return { ...snapshot, files };
}

/**
 * Style for writing rules into `file`: the writer's styleForFile, learning
 * from rule postings too (a budget file holds nothing but rules).
 */
export function ruleStyle(snapshot: VaultSnapshot, file: string): InferredStyle {
  const s = withSwappedRules(snapshot, file);
  return styleForFile(s.files, file, s.rootFile);
}

function replacePatch(loc: LocatedRule, newLines: string[], eol: string): Patch[] {
  const expected = rangeText(loc.lines, loc.startLine, loc.endLine)!;
  const text = newLines.join(eol);
  if (text === expected) return [];
  return [{ op: 'replace', file: loc.file, startLine: loc.startLine, endLine: loc.endLine, expected, text }];
}

/**
 * Edit a rule. Returns [] when the draft equals the rule. Everything the
 * draft leaves as it was stays byte-identical.
 */
export function planEditRule(snapshot: VaultSnapshot, rule: RuleRef, draft: RuleDraft): Patch[] {
  const loc = locateRule(snapshot, rule);
  const all = loc.lines.lines;
  const parsed = parseRuleLines(all.slice(loc.startLine - 1, loc.endLine))!;
  const h = parsed.header;
  const style = ruleStyle(snapshot, loc.file);

  // Header.
  const sameComment = firstComment(draft.comment) === firstComment(parsed.comment);
  const sameHeader = normalizePeriod(draft.period) === normalizePeriod(h.period) && draft.description.trim() === h.description.trim() && sameComment;
  let header = h.raw;
  if (!sameHeader) {
    const errs = validateRuleHeader(draft);
    if (errs.length) throw new RuleError(errs.join('; '));
    header = formatRuleHeader(draft, sameComment ? h.tail : undefined);
  }
  if (draft.postings.length === 0) throw new RuleError('A recurring transaction needs at least one posting');

  // Body: the writer's minimal edit, on the file with rule headers swapped for stand-ins.
  const fakeSnap = withSwappedRules(snapshot, loc.file);
  const standIn = splitLines(fakeSnap.files[loc.file]!).lines.slice(loc.startLine - 1, loc.endLine);
  const source: SourceSpan = { file: loc.file, startLine: loc.startLine, endLine: loc.endLine };
  const txn: Txn = { index: 0, date: STAND_IN_DATE, status: '', code: '', description: STAND_IN_DESC, comment: '', tags: [], postings: [], source };
  const patches = planEdit(fakeSnap, txn, {
    date: STAND_IN_DATE,
    description: STAND_IN_DESC,
    ...(draft.comment !== undefined ? { comment: draft.comment } : {}),
    postings: draft.postings,
  });
  const body = patches[0]?.op === 'replace' ? splitText(patches[0].text) : standIn;
  return replacePatch(loc, [header, ...body.slice(1)], style.eol);
}

/** Text lines from user input: BOM and leading/trailing blank lines dropped. */
function textLines(text: string): string[] {
  const lines = splitText(text.startsWith('﻿') ? text.slice(1) : text);
  while (lines.length && isBlank(lines[lines.length - 1]!)) lines.pop();
  while (lines.length && isBlank(lines[0]!)) lines.shift();
  return lines;
}

function assertRuleText(lines: string[]): void {
  if (!lines[0]?.startsWith('~')) throw new RuleError('A periodic rule starts with ~ at the beginning of the line, e.g. "~ monthly  Rent"');
}

/** Replace a rule's text verbatim (EOLs normalised to the file's; leading/trailing blank lines dropped). Empty text deletes it. */
export function planReplaceRuleText(snapshot: VaultSnapshot, rule: RuleRef, text: string): Patch[] {
  const loc = locateRule(snapshot, rule);
  const lines = textLines(text);
  if (!lines.length) return planDeleteRule(snapshot, rule);
  assertRuleText(lines);
  return replacePatch(loc, lines, ruleStyle(snapshot, loc.file).eol);
}

/** Delete a rule and one adjacent blank separator line (the one after it, else the one before). */
export function planDeleteRule(snapshot: VaultSnapshot, rule: RuleRef): Patch[] {
  const loc = locateRule(snapshot, rule);
  const all = loc.lines.lines;
  let { startLine, endLine } = loc;
  if (endLine < all.length && isBlank(all[endLine]!)) endLine++;
  else if (startLine > 1 && isBlank(all[startLine - 2]!)) startLine--;
  const expected = rangeText(loc.lines, startLine, endLine)!;
  return [{ op: 'delete', file: loc.file, startLine, endLine, expected }];
}

/**
 * Patch adding `body` (rule text, no trailing EOL, in the file's EOL) to a
 * file: after the file's last rule when it has rules (with a blank line
 * before, and after when something follows), else appended with one blank
 * line before it. The file's final-newline state is kept.
 */
function addBody(snapshot: VaultSnapshot, file: string, body: string, eol: string): Patch[] {
  const text = snapshot.files[file] ?? '';
  const l = splitLines(text);
  const n = l.lines.length;
  const spans = findRuleSpans(l, file);
  const lastRule = spans[spans.length - 1];
  if (lastRule && lastRule.endLine < n) {
    // Lines after the rule: skip its blank separator so the new rule sits right after it.
    let at = lastRule.endLine + 1;
    if (isBlank(l.lines[at - 1]!)) {
      // "rule, blank, X" -> "rule, blank, NEW, blank, X" (or "..., NEW" at the end).
      at++;
      if (at > n) return appendBody(l, file, body, eol);
      return [{ op: 'insert', file, beforeLine: at, text: `${body}${isBlank(l.lines[at - 1]!) ? '' : eol}` }];
    }
    return [{ op: 'insert', file, beforeLine: at, text: `${eol}${body}${eol}` }];
  }
  return appendBody(l, file, body, eol);
}

function appendBody(l: Lines, file: string, body: string, eol: string): Patch[] {
  const n = l.lines.length;
  if (n === 0) return [{ op: 'append', file, text: body + eol }];
  const last = l.lines[n - 1]!;
  if (l.eols[n - 1] !== '') return [{ op: 'append', file, text: `${isBlank(last) ? '' : eol}${body}${eol}` }];
  // No final newline: end the last line, separate, and keep no final newline.
  return [{ op: 'append', file, text: `${eol}${isBlank(last) ? '' : eol}${body}` }];
}

/** Add a rule to `targetFile` (default: the root file), in that file's style. */
export function planAddRule(snapshot: VaultSnapshot, draft: RuleDraft, opts: { targetFile?: string } = {}): Patch[] {
  assertValidRule(draft);
  const file = opts.targetFile ?? snapshot.rootFile;
  const style = ruleStyle(snapshot, file);
  return addBody(snapshot, file, formatRule(draft, style), style.eol);
}

/** Add a rule written as text (must start with `~`) to `targetFile` (default: the root file). */
export function planAddRuleText(snapshot: VaultSnapshot, text: string, opts: { targetFile?: string } = {}): Patch[] {
  const lines = textLines(text);
  assertRuleText(lines);
  const file = opts.targetFile ?? snapshot.rootFile;
  const eol = ruleStyle(snapshot, file).eol;
  return addBody(snapshot, file, lines.join(eol), eol);
}

/** The file new rules go to: the first (root first, then by path) that already has rules, else the root file. */
export function defaultRuleFile(snapshot: Pick<VaultSnapshot, 'files' | 'rootFile'>, candidates: string[] = Object.keys(snapshot.files).sort()): string {
  const order = [snapshot.rootFile, ...candidates.filter((f) => f !== snapshot.rootFile)];
  return order.find((f) => snapshot.files[f] !== undefined && findRuleSpans(snapshot.files[f]!, f).length > 0) ?? snapshot.rootFile;
}
