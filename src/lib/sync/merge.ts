// Line-wise three-way merge for journal files (ported from mycelium-web
// src/lib/git/merge.ts).
//
// Lines are merged with diff3 while keeping each line's own terminator, so a
// clean merge reproduces exactly the bytes both sides wrote: no newline
// normalisation, no re-serialisation.
//
// Two refinements over plain diff3, both aimed at how journals are edited on
// two devices:
//  * Same-shape edits (both sides kept the line count of a region) merge line
//    by line, so editing two *adjacent* lines is not a conflict.
//  * Pure insertions at the same spot (the base region is empty — typically
//    both devices appended a transaction at the end of the file) keep both,
//    local first. This is on by default (`unionInsertions`); the sync engine's
//    post-merge validation (`hledger check`) catches the rare union that
//    produces an invalid journal.

import { diff3Merge } from 'node-diff3';

export interface MergeLabels {
  local: string;
  base: string;
  remote: string;
}

export interface MergeOptions {
  /** Keep both sides of a same-place pure insertion (default true). */
  unionInsertions?: boolean;
  labels?: Partial<MergeLabels>;
}

export interface MergeResult {
  clean: boolean;
  /**
   * The merged text. When not clean, conflicting regions carry diff3-style
   * markers (`<<<<<<< local`, `||||||| base`, `=======`, `>>>>>>> remote`).
   */
  text: string;
  /** Number of conflicting regions (0 when clean). */
  conflicts: number;
}

const DEFAULT_LABELS: MergeLabels = { local: 'local', base: 'base', remote: 'remote' };

/** Split text into lines that keep their terminators. */
export function linesWithEol(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

/** Make sure a chunk ends with a newline before something is appended after it. */
const terminated = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);

function mergeLineByLine(base: string[], ours: string[], theirs: string[]): string | null {
  if (base.length !== ours.length || base.length !== theirs.length) return null;
  let out = '';
  for (let i = 0; i < base.length; i += 1) {
    const b = base[i]!;
    const o = ours[i]!;
    const t = theirs[i]!;
    if (o === t || t === b) out += o;
    else if (o === b) out += t;
    else return null;
  }
  return out;
}

/** Three-way merge of `local` and `remote`, both derived from `base`. */
export function merge3(
  base: string,
  local: string,
  remote: string,
  options: MergeOptions = {},
): MergeResult {
  if (local === remote) return { clean: true, text: local, conflicts: 0 };
  if (base === local) return { clean: true, text: remote, conflicts: 0 };
  if (base === remote) return { clean: true, text: local, conflicts: 0 };
  const labels = { ...DEFAULT_LABELS, ...options.labels };
  const union = options.unionInsertions ?? true;
  const blocks = diff3Merge(linesWithEol(local), linesWithEol(base), linesWithEol(remote), {
    excludeFalseConflicts: true,
  });
  let text = '';
  let conflicts = 0;
  for (const block of blocks) {
    if (block.ok) {
      text += block.ok.join('');
      continue;
    }
    if (!block.conflict) continue;
    const { a, o, b } = block.conflict;
    const refined = mergeLineByLine(o, a, b);
    if (refined !== null) {
      text += refined;
      continue;
    }
    const ours = a.join('');
    const theirs = b.join('');
    if (union && o.length === 0) {
      text += terminated(ours) + theirs;
      continue;
    }
    conflicts += 1;
    text +=
      `<<<<<<< ${labels.local}\n${terminated(ours)}` +
      `||||||| ${labels.base}\n${terminated(o.join(''))}` +
      `=======\n${terminated(theirs)}` +
      `>>>>>>> ${labels.remote}\n`;
  }
  return { clean: conflicts === 0, text, conflicts };
}

/** True when `text` still contains merge conflict markers. */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7} .*\n[\s\S]*?^={7}\n[\s\S]*?^>{7} /m.test(text);
}
