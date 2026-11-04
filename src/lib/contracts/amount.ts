// Lead-owned contract. Changes require lead review (BUILD_PLAN §6, §15.3).
//
// Amounts never become JS floats. `quantity` is an exact decimal string
// ("-1234.50"); arithmetic uses decimal.js-light via src/lib/engine/decimal.ts.

/** How hledger displays a commodity, from its `astyle` (inferred or declared). */
export interface AmountStyle {
  /** Commodity symbol on the left (`$10`) or right (`10 EUR`). */
  side: 'L' | 'R';
  /** A space between symbol and number. */
  spaced: boolean;
  /** `.` or `,`. */
  decimalMark: '.' | ',';
  /** Digit group separator and group sizes (e.g. `,` [3]); null if none. */
  digitGroups: { separator: string; sizes: number[] } | null;
  /** Display precision; null means "as written" (NaturalPrecision). */
  precision: number | null;
}

export interface Amount {
  commodity: string;
  /** Exact decimal string in canonical form: optional '-', digits, optional '.digits'. Always '.' as the mark. */
  quantity: string;
  style: AmountStyle;
  /** `@` unit cost or `@@` total cost, if written. */
  cost?: { kind: 'unit' | 'total'; amount: Amount } | null;
}

/** A multi-commodity amount: one entry per commodity (hledger MixedAmount). Empty = zero. */
export type MixedAmount = Amount[];
