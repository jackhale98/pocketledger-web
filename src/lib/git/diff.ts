// Line diffs for reviewing uncommitted changes (ported from mycelium-web
// src/lib/git/diff.ts, without hunk reverting).

import { diffComm } from 'node-diff3';
import { linesWithEol } from '$lib/sync/merge';

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  /** The line without its terminator. */
  text: string;
  /** Line number in the old file (context and removals). */
  oldNo: number | null;
  /** Line number in the new file (context and additions). */
  newNo: number | null;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

function allLines(before: string, after: string): DiffLine[] {
  const strip = (l: string) => l.replace(/\r?\n$/, '');
  const all: DiffLine[] = [];
  let o = 1;
  let n = 1;
  for (const part of diffComm(linesWithEol(before), linesWithEol(after))) {
    if (part.common) {
      for (const l of part.common) all.push({ kind: 'context', text: strip(l), oldNo: o++, newNo: n++ });
    } else {
      for (const l of part.buffer1 ?? [])
        all.push({ kind: 'remove', text: strip(l), oldNo: o++, newNo: null });
      for (const l of part.buffer2 ?? [])
        all.push({ kind: 'add', text: strip(l), oldNo: null, newNo: n++ });
    }
  }
  return all;
}

/** Unified-diff hunks with `context` unchanged lines around each change. */
export function diffLines(before: string | null, after: string | null, context = 3): DiffHunk[] {
  const all = allLines(before ?? '', after ?? '');
  const keep = new Set<number>();
  all.forEach((line, i) => {
    if (line.kind === 'context') return;
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k += 1)
      keep.add(k);
  });
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = all[i]!;
    if (!current || i !== last + 1) {
      current = { oldStart: line.oldNo ?? line.newNo ?? 1, newStart: line.newNo ?? 1, lines: [] };
      hunks.push(current);
    }
    current.lines.push(line);
    last = i;
  }
  return hunks;
}
