import type { BalanceAssertion, Posting, RegisterRow, SourceSpan, Status, Txn } from '../../contracts/engine';
import { decodeAmount, decodeMixed, type HAmount } from './amount';

export interface HSourcePos {
  sourceName: string;
  sourceLine: number;
  sourceColumn: number;
}
export interface HPosting {
  paccount: string;
  pamount: HAmount[];
  pstatus: 'Unmarked' | 'Pending' | 'Cleared';
  pcomment: string;
  ptags: [string, string][];
  ptype: 'RegularPosting' | 'VirtualPosting' | 'BalancedVirtualPosting';
  pdate: string | null;
  pdate2: string | null;
  pbalanceassertion: null | { baamount: HAmount; batotal: boolean; bainclusive: boolean };
  poriginal: HPosting | null;
}
export interface HTxn {
  tindex: number;
  tdate: string;
  tdate2: string | null;
  tstatus: 'Unmarked' | 'Pending' | 'Cleared';
  tcode: string;
  tdescription: string;
  tcomment: string;
  ttags: [string, string][];
  tpostings: HPosting[];
  tsourcepos: [HSourcePos, HSourcePos];
}

export const decodeStatus = (s: string): Status => (s === 'Cleared' ? '*' : s === 'Pending' ? '!' : '');

const HIDDEN = (t: [string, string]) => t[0].startsWith('_');

/** Map an absolute engine path (/vault/x.journal) to a vault-relative one. */
export type PathMapper = (abs: string) => string | null;

export function decodeSpan(pos: [HSourcePos, HSourcePos], toVault: PathMapper): SourceSpan | undefined {
  const [start, end] = pos;
  const file = toVault(start.sourceName);
  if (!file) return undefined;
  const endLine = end.sourceColumn === 1 ? end.sourceLine - 1 : end.sourceLine;
  return { file, startLine: start.sourceLine, endLine: Math.max(start.sourceLine, endLine) };
}

export function decodePosting(p: HPosting): Posting {
  const assertion: BalanceAssertion | null = p.pbalanceassertion
    ? {
        amount: decodeAmount(p.pbalanceassertion.baamount),
        total: p.pbalanceassertion.batotal,
        inclusive: p.pbalanceassertion.bainclusive,
      }
    : null;
  const generated = p.ptags.some(([k]) => k === '_generated-posting' || k === 'generated-posting');
  return {
    account: p.paccount,
    amount: decodeMixed(p.pamount),
    inferred: false,
    status: decodeStatus(p.pstatus),
    comment: p.pcomment,
    tags: p.ptags.filter((t) => !HIDDEN(t)),
    type: p.ptype === 'VirtualPosting' ? 'virtual' : p.ptype === 'BalancedVirtualPosting' ? 'balanced-virtual' : 'regular',
    date: p.pdate,
    date2: p.pdate2,
    assertion,
    ...(generated ? { generated } : {}),
  };
}

export function decodeTxn(t: HTxn, toVault: PathMapper): Txn {
  const generated = t.ttags.some(([k]) => k === '_generated-transaction' || k === 'generated-transaction');
  const txn: Txn = {
    index: t.tindex,
    date: t.tdate,
    date2: t.tdate2,
    status: decodeStatus(t.tstatus),
    code: t.tcode,
    description: t.tdescription,
    comment: t.tcomment,
    tags: t.ttags.filter((x) => !HIDDEN(x)),
    postings: t.tpostings.map(decodePosting),
  };
  if (generated) txn.generated = true;
  else {
    const span = decodeSpan(t.tsourcepos, toVault);
    if (span) txn.source = span;
  }
  return txn;
}

export type HRegisterRow = [string, string | null, string, HPosting, HAmount[]];

export function decodeRegister(rows: HRegisterRow[]): RegisterRow[] {
  return rows.map(([date, date2, description, posting, balance]) => ({
    date,
    date2,
    description,
    posting: decodePosting(posting),
    balance: decodeMixed(balance),
    txnIndex: Number((posting as unknown as { ptransaction_?: string }).ptransaction_ ?? 0) || 0,
  }));
}

/**
 * hledger doesn't say which posting amounts were inferred. Mark them from the
 * source text: a posting line with no amount after the account (2+ spaces).
 */
export function markInferred(txn: Txn, sourceLines: string[] | undefined): Txn {
  if (!txn.source || !sourceLines) return txn;
  const lines = sourceLines.slice(txn.source.startLine, txn.source.endLine); // lines after header
  const postingLines = lines.filter((l) => /^[ \t]+[^ \t;#*]/.test(l) || /^[ \t]+[*!][ \t]/.test(l));
  let i = 0;
  for (const p of txn.postings) {
    if (p.generated) continue;
    const line = postingLines[i++];
    if (line === undefined) break;
    const body = line.replace(/;.*$/, '').trim().replace(/^[*!]\s*/, '');
    // account ends at two spaces or a tab
    const m = /^(\S.*?)(?: {2,}|\t)(.*)$/.exec(body);
    p.inferred = !m || m[2]!.trim() === '';
  }
  return txn;
}
