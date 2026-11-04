// Line-level view of a journal file that loses nothing: every line keeps its
// own terminator, and a UTF-8 BOM is held apart so line 1's text is clean.
// joinLines(splitLines(t)) === t for every string t.

export const BOM = '﻿';

/** The terminator after a line: '' only for a last line without one. */
export type LineEnd = '\n' | '\r\n' | '';

export interface Lines {
  bom: boolean;
  /** Line contents without terminators. lines[0] is line 1. */
  lines: string[];
  /** eols[i] is the terminator that followed lines[i]. */
  eols: LineEnd[];
}

/** Split text into lines, keeping each line's terminator. "" has zero lines; "a\n" has one. */
export function splitLines(text: string): Lines {
  let bom = false;
  if (text.startsWith(BOM)) {
    bom = true;
    text = text.slice(1);
  }
  const lines: string[] = [];
  const eols: LineEnd[] = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    if (nl === -1) {
      lines.push(text.slice(i));
      eols.push('');
      break;
    }
    const crlf = nl > i && text.charCodeAt(nl - 1) === 13;
    lines.push(text.slice(i, crlf ? nl - 1 : nl));
    eols.push(crlf ? '\r\n' : '\n');
    i = nl + 1;
  }
  return { bom, lines, eols };
}

export function joinLines(l: Lines): string {
  let out = l.bom ? BOM : '';
  for (let i = 0; i < l.lines.length; i++) out += l.lines[i]! + l.eols[i]!;
  return out;
}

/** The file's line terminator: CRLF when most lines end that way, else LF (also for a file with no terminators). */
export function detectEol(text: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Exact text of lines startLine..endLine (1-based, inclusive), joined with the
 * terminators actually between them, without the last line's terminator.
 * Returns null when the range is outside the file.
 */
export function rangeText(l: Lines, startLine: number, endLine: number): string | null {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  if (startLine < 1 || endLine < startLine || endLine > l.lines.length) return null;
  let out = '';
  for (let i = startLine - 1; i < endLine; i++) {
    out += l.lines[i]!;
    if (i < endLine - 1) out += l.eols[i]!;
  }
  return out;
}

/** Split a multi-line string on any line terminator (CRLF, LF or a lone CR). */
export function splitText(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Normalise every line terminator in `text` to `eol`. */
export function normalizeEol(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}
