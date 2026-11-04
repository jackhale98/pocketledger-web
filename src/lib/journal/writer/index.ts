// The journal writer: the only code that changes journal text. See docs/WRITER.md.

import type { Writer } from '../../contracts/writer';
import { apply } from './apply';
import { formatTxn } from './format';
import { planAdd, planDelete, planEdit, planReplaceText } from './plan';
import { inferStyle } from './style';

export { apply } from './apply';
export { formatTxn, formatHeaderLine, formatPosting, formatPostingLine, formatAmountText, formatDate, resolveCommodity, type Layout } from './format';
export { planAdd, planDelete, planEdit, planReplaceText, locateTxn } from './plan';
export { inferStyle, commodityStyle, styleForFile, type InferredStyle } from './style';
export { draftFromTxn, draftFromText, parseTxnLines, parseHeaderLine, parsePostingLine, normalizeDate, type ParsedTxn, type PostingLine, type HeaderLine } from './parse';
export { validateDraft, assertValidDraft, DraftError } from './validate';
export {
  parseAmount,
  parseNumber,
  canonicalNumber,
  formatNumber,
  renderAmount,
  quoteCommodity,
  visualWidth,
  type AmountParts,
  type CommodityStyle,
  type DecimalMark,
  type ParsedNumber,
} from './amount';

export const writer: Writer = { formatTxn, planAdd, planEdit, planReplaceText, planDelete, apply, inferStyle };
