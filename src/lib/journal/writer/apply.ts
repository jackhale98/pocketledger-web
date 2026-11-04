// Apply patches to file texts. Pure: returns a new file map and never mutates
// the input. Line patches in one file are applied bottom-up so every patch's
// line numbers refer to the original text; appends go last.

import { StalePatchError, type Patch } from '../../contracts/writer';
import { detectEol, joinLines, rangeText, splitLines, splitText, type LineEnd, type Lines } from '../locate';

type LinePatch = Exclude<Patch, { op: 'append' }>;

function first(p: LinePatch): number {
  return p.op === 'insert' ? p.beforeLine - 0.5 : p.startLine;
}

function last(p: LinePatch): number {
  return p.op === 'insert' ? p.beforeLine - 0.5 : p.endLine;
}

function checkExpected(l: Lines, p: Extract<Patch, { expected: string }>, eol: string): void {
  const actual = rangeText(l, p.startLine, p.endLine);
  if (actual === null) throw new StalePatchError(p.file, p.startLine);
  if (actual === p.expected) return;
  // The contract describes `expected` as joined with the file's EOL; accept that form too for mixed-EOL files.
  if (l.lines.slice(p.startLine - 1, p.endLine).join(eol) === p.expected) return;
  throw new StalePatchError(p.file, p.startLine);
}

function applyLinePatch(l: Lines, p: LinePatch, eol: '\n' | '\r\n'): void {
  const n = l.lines.length;
  if (p.op === 'insert') {
    if (!Number.isInteger(p.beforeLine) || p.beforeLine < 1 || p.beforeLine > n + 1) throw new StalePatchError(p.file, p.beforeLine);
    const add = splitText(p.text);
    const eols: LineEnd[] = add.map(() => eol);
    if (p.beforeLine === n + 1 && n > 0 && l.eols[n - 1] === '') {
      // Inserting after a last line without a newline: it gets one, the new last line keeps "none".
      l.eols[n - 1] = eol;
      eols[eols.length - 1] = '';
    }
    l.lines.splice(p.beforeLine - 1, 0, ...add);
    l.eols.splice(p.beforeLine - 1, 0, ...eols);
    return;
  }
  checkExpected(l, p, eol);
  const { startLine: a, endLine: b } = p;
  const lastEol = l.eols[b - 1]!;
  if (p.op === 'replace') {
    const add = splitText(p.text);
    const eols: LineEnd[] = add.map(() => eol);
    eols[eols.length - 1] = lastEol;
    l.lines.splice(a - 1, b - a + 1, ...add);
    l.eols.splice(a - 1, b - a + 1, ...eols);
    return;
  }
  l.lines.splice(a - 1, b - a + 1);
  l.eols.splice(a - 1, b - a + 1);
  // Deleting the last line(s): the new last line takes over the old final-newline state.
  if (b === n && a > 1) l.eols[a - 2] = lastEol;
}

function applyToText(text: string, patches: Patch[]): string {
  const eol = detectEol(text);
  const l = splitLines(text);
  const linePatches = patches
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: LinePatch; i: number } => x.p.op !== 'append')
    .sort((x, y) => first(y.p) - first(x.p) || y.i - x.i);
  for (let k = 1; k < linePatches.length; k++) {
    const upper = linePatches[k - 1]!.p;
    const lower = linePatches[k]!.p;
    const touching = last(lower) >= first(upper) && !(lower.op === 'insert' && upper.op === 'insert');
    if (touching) throw new Error(`Overlapping patches in ${lower.file} at line ${first(upper)}`);
  }
  for (const { p } of linePatches) applyLinePatch(l, p, eol);
  let out = joinLines(l);
  for (const p of patches) if (p.op === 'append') out += p.text.replace(/\r\n|\r|\n/g, eol);
  return out;
}

/** Apply patches; throws StalePatchError when an `expected` text no longer matches (reload and re-plan). */
export function apply(files: Record<string, string>, patches: Patch[]): Record<string, string> {
  const out: Record<string, string> = { ...files };
  const byFile = new Map<string, Patch[]>();
  for (const p of patches) {
    const list = byFile.get(p.file);
    if (list) list.push(p);
    else byFile.set(p.file, [p]);
  }
  for (const [file, list] of byFile) out[file] = applyToText(files[file] ?? '', list);
  return out;
}
