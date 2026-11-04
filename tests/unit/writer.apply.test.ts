import { describe, expect, it } from 'vitest';
import { StalePatchError, type Patch } from '../../src/lib/contracts/writer';
import { apply } from '../../src/lib/journal/writer';
import { findTxnSpans, joinLines, normalizeSpan, rangeText, splitLines } from '../../src/lib/journal/locate';

const F = 'f.journal';

describe('apply', () => {
  const text = 'l1\nl2\nl3\nl4\nl5\n';

  it('applies several patches bottom-up against the original line numbers', () => {
    const patches: Patch[] = [
      { op: 'replace', file: F, startLine: 2, endLine: 2, expected: 'l2', text: 'L2a\nL2b' },
      { op: 'delete', file: F, startLine: 4, endLine: 4, expected: 'l4' },
      { op: 'insert', file: F, beforeLine: 1, text: 'top' },
      { op: 'append', file: F, text: 'end\n' },
    ];
    expect(apply({ [F]: text }, patches)[F]).toBe('top\nl1\nL2a\nL2b\nl3\nl5\nend\n');
  });

  it('is pure and leaves other files alone', () => {
    const files = { [F]: text, 'other.journal': 'x' };
    const out = apply(files, [{ op: 'delete', file: F, startLine: 1, endLine: 1, expected: 'l1' }]);
    expect(files[F]).toBe(text);
    expect(out['other.journal']).toBe('x');
    expect(out).not.toBe(files);
  });

  it('throws StalePatchError on an expected mismatch or a range outside the file', () => {
    try {
      apply({ [F]: text }, [{ op: 'replace', file: F, startLine: 3, endLine: 3, expected: 'changed', text: 'x' }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StalePatchError);
      expect(e).toMatchObject({ file: F, startLine: 3 });
    }
    expect(() => apply({ [F]: 'short' }, [{ op: 'delete', file: F, startLine: 1, endLine: 99, expected: 'short' }])).toThrow(StalePatchError);
    expect(() => apply({ [F]: text }, [{ op: 'insert', file: F, beforeLine: 99, text: 'x' }])).toThrow(StalePatchError);
  });

  it('rejects overlapping patches (ported)', () => {
    expect(() =>
      apply({ [F]: text }, [
        { op: 'delete', file: F, startLine: 1, endLine: 3, expected: 'l1\nl2\nl3' },
        { op: 'delete', file: F, startLine: 3, endLine: 4, expected: 'l3\nl4' },
      ]),
    ).toThrow(/Overlapping/);
  });

  it('preserves BOM and CRLF, normalising inserted text to CRLF', () => {
    const crlf = '﻿a\r\nb\r\n';
    const out = apply({ [F]: crlf }, [
      { op: 'replace', file: F, startLine: 2, endLine: 2, expected: 'b', text: 'B1\nB2' },
      { op: 'append', file: F, text: '\nc\n' },
    ])[F];
    expect(out).toBe('﻿a\r\nB1\r\nB2\r\n\r\nc\r\n');
  });

  it('keeps the final-newline state when the last lines change', () => {
    expect(apply({ [F]: 'a\nb' }, [{ op: 'replace', file: F, startLine: 2, endLine: 2, expected: 'b', text: 'B' }])[F]).toBe('a\nB');
    expect(apply({ [F]: 'a\nb' }, [{ op: 'delete', file: F, startLine: 2, endLine: 2, expected: 'b' }])[F]).toBe('a');
    expect(apply({ [F]: 'a\nb' }, [{ op: 'insert', file: F, beforeLine: 3, text: 'c' }])[F]).toBe('a\nb\nc');
    expect(apply({ [F]: 'a\nb\n' }, [{ op: 'insert', file: F, beforeLine: 3, text: 'c' }])[F]).toBe('a\nb\nc\n');
  });

  it('accepts expected text joined with the file EOL in a mixed-EOL file', () => {
    const mixed = 'a\r\nb\nc\r\n';
    expect(apply({ [F]: mixed }, [{ op: 'delete', file: F, startLine: 1, endLine: 2, expected: 'a\r\nb' }])[F]).toBe('c\r\n');
  });
});

describe('locate', () => {
  it('splitLines/joinLines round-trip every byte', () => {
    for (const t of ['', '\n', 'a', 'a\n', 'a\r\nb', '﻿a\r\n\r\n', 'a\rb\n', '\n\n\n', 'x\r\n\ny']) expect(joinLines(splitLines(t))).toBe(t);
    expect(splitLines('﻿a\r\nb')).toEqual({ bom: true, lines: ['a', 'b'], eols: ['\r\n', ''] });
  });

  it('rangeText joins with the real terminators', () => {
    const l = splitLines('a\r\nb\r\nc');
    expect(rangeText(l, 1, 2)).toBe('a\r\nb');
    expect(rangeText(l, 3, 4)).toBeNull();
  });

  it('finds transactions, not periodic/auto rules or comment blocks', () => {
    const text = [
      '~ monthly',
      '    expenses:food  $400',
      '= expenses',
      '    (budget)  *-1',
      'comment',
      '2024-01-01 hidden',
      '    a  $1',
      'end comment',
      '2024-01-02 real  ; c',
      '    ; comment',
      '    a  $1',
      '   ',
      '    b',
      'Y 2024',
      '1/5 yearless',
      '    a  1',
      '    b',
    ].join('\n');
    expect(findTxnSpans(text, F)).toEqual([
      { file: F, startLine: 9, endLine: 11 },
      { file: F, startLine: 15, endLine: 17 },
    ]);
  });

  it('normalizeSpan checks the header and re-derives the end', () => {
    const l = splitLines('2024-01-01 a\n    x  $1\n    y\n\nP 2024-01-01 A $1\n');
    expect(normalizeSpan(l, { startLine: 1, endLine: 5 })).toEqual({ startLine: 1, endLine: 3 });
    expect(normalizeSpan(l, { startLine: 1, endLine: 1 })).toEqual({ startLine: 1, endLine: 3 });
    expect(normalizeSpan(l, { startLine: 2, endLine: 3 })).toBeNull();
    expect(normalizeSpan(l, { startLine: 5, endLine: 5 })).toBeNull();
  });
});
