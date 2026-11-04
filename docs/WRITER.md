# Journal writer

`src/lib/journal/writer` is the only code that changes journal text. It turns
an intent (add / edit / delete a transaction, or replace its text) into
**line patches** against the current text, and applies them. Everything outside
a patch's lines stays byte-identical: comments, alignment, directives hledger
ignores, line endings, BOM.

Contract: `src/lib/contracts/writer.ts`. Helpers for lines and transaction
boundaries: `src/lib/journal/locate`.

## Modules

| Module | Exports |
| --- | --- |
| `locate/lines.ts` | `splitLines`, `joinLines` (lossless, per-line terminators, BOM held apart), `detectEol`, `rangeText`, `splitText`, `normalizeEol` |
| `locate/spans.ts` | `isTxnHeader`, `isContinuation`, `isBlank`, `findTxnSpans`, `txnExtent`, `normalizeSpan`, `attachedCommentStart` |
| `writer/style.ts` | `inferStyle`, `styleForFile`, `commodityStyle` |
| `writer/format.ts` | `formatTxn`, `formatHeaderLine`, `formatPosting(Line)`, `formatAmountText` |
| `writer/parse.ts` | `draftFromTxn`, `draftFromText`, `parseTxnLines`, `parseHeaderLine`, `parsePostingLine` |
| `writer/plan.ts` | `planAdd`, `planEdit`, `planReplaceText`, `planDelete`, `locateTxn` |
| `writer/apply.ts` | `apply` |
| `writer/validate.ts` | `validateDraft`, `assertValidDraft`, `DraftError` |
| `writer/index.ts` | all of the above and `writer: Writer` |

## Transaction boundaries

A transaction starts with a date at column 0 (`2024-01-15`, `2024/1/5`,
`2024.01.05`, year-less `1/15`, optional `=DATE2`) and continues over the
following indented non-blank lines (postings and `;` comment lines). A blank or
whitespace-only line, or any column-0 line, ends it — this is hledger's rule
(checked against hledger 1.52). `comment … end comment` blocks are skipped;
`~` periodic and `=` auto rules are not transactions.

Spans from the engine (`Txn.source`, derived from hledger's `tsourcepos`) are
**verified, not trusted**: the start line must be a transaction header (else
`StalePatchError`), and the end line is re-derived from the text, which trims
trailing blank / column-0 lines and extends a span that stops short.

## Patches

All line numbers are 1-based and refer to the text the patch was planned on.

- `replace startLine..endLine` — `expected` is the exact current text of those
  lines, joined with the terminators actually between them, with no trailing
  terminator (for a single-EOL file that equals "joined with the file's EOL";
  `apply` accepts that form too). `text` has no trailing EOL. The last new line
  inherits the old last line's terminator, so a file's final-newline state is
  unchanged.
- `delete startLine..endLine` — same `expected`. Deleting through the last line
  moves the old final-newline state to the new last line.
- `insert beforeLine` — `text` is inserted as whole lines before `beforeLine`
  (`lineCount + 1` = after the last line); a terminator is added after it.
- `append` — `text` is concatenated verbatim at the end of the file.

`apply(files, patches)` is pure. Per file, line patches are applied bottom-up
(so all numbers stay valid), then appends in order. Every inserted terminator
is normalised to the file's EOL (CRLF if most lines use CRLF); the BOM is kept.
An `expected` mismatch or a range outside the file throws `StalePatchError`
(reload and re-plan); overlapping patches throw an `Error`.

## Planners

### `planEdit(snapshot, txn, draft)`

One `replace` over the transaction, or `[]` when the result equals the
current text. Minimal by construction:

- Header line kept verbatim when date (normalised), date2, status, code,
  description and first comment line are unchanged. Otherwise re-rendered,
  reusing the original date token(s) and the `  ; comment` tail when those did
  not change.
- Comment continuation lines kept verbatim unless their text changed.
- Postings are aligned with an LCS on structural equality (account, type,
  status, amount by *value* in its commodity, cost, assertion, comment). Equal
  postings keep their lines (including comment lines) byte-identical. Between
  them, postings pair up in order as modifications; extras are added/removed.
- A modified posting reuses the original indent and, for each piece that did
  not change, its exact text (amount, cost/lot, assertion, comment tail) and
  gap. A changed amount keeps the original side/spacing of the same commodity.
- Only re-rendered parts are validated, so a no-op never fails on unusual
  existing syntax.

Hence `planEdit(s, t, draftFromTxn(t, s))` is `[]` for every transaction
(the fidelity suite checks every transaction of every fixture).

### `draftFromTxn(txn, text | snapshot)`

Builds the edit form's `TxnDraft` from the span's own text: date normalised to
`YYYY-MM-DD` when it has a year; `amount` is the signed number as written
(`-$82.17` → amount `-82.17`, commodity `$`); `commodity` is `''` for an amount
without one; `cost` holds everything between the amount and the assertion
(lots `{…}`, `[date]`, `@`/`@@` costs) verbatim; `assertion` verbatim;
comments are the inline comment plus continuation lines joined with `\n` (a
leading empty line means "no inline comment"). An amount that is not a plain
number (e.g. an expression) is kept verbatim in `amount`.

### `planAdd(snapshot, draft, { targetFile?, dateOrder?, txns? })`

- **Append** (default) to `targetFile ?? rootFile`, with exactly one blank line
  before the new transaction (none added if the file already ends with a blank
  line; existing blank lines are never removed). **Final newline policy: the
  file's state is kept** — a file that ended with a newline still does; a file
  without a final newline gets `EOL EOL txn` and still has none. An empty or
  missing file gets `txn EOL`.
- **Date order** (`dateOrder` + `txns`): `insert` before the first transaction
  of that file (by line) dated strictly after the draft — so same-date entries
  go after existing ones — and above any column-0 comment lines directly
  attached to it. A blank line is added above when the line before is not
  blank, and one below. No later transaction → append.
- A file with no postings to learn style from (new year file, directives only)
  borrows the root file's style (`styleForFile`).

### `planReplaceText(snapshot, txn, text)`

Replaces the span with `text`, EOLs normalised to the file's, leading/trailing
blank lines dropped; empty text = `planDelete`.

### `planDelete(snapshot, txn)`

Deletes the span plus one adjacent blank separator line — the one after it,
else the one before — so no double blank line is left and nothing else is
touched.

## Style inference (`inferStyle(text)`)

Returns a `JournalStyle` (plus `commodities` and `samples`, see "Contract
notes"); memoised per text.

- `indent`: most common posting indent (exact string, e.g. `"  "` or `"\t"`).
- `amountColumn`: hledger right-aligns amounts so they **end** at a common
  column; the amount *with its cost* is what is aligned (`10 AAPL @ $5.00`),
  the assertion follows. Inferred as the most common visual end column (tabs
  expand to 8-column stops) of amount+cost over all postings, if it covers at
  least half of them and at least two; else `null`.
- `commoditySide`/`commoditySpaced`: those of the default commodity.
- `decimalMark`: `decimal-mark` directive, else majority of unambiguous numbers.
- `thousandsSeparator`: most common digit group mark seen, else `null`.
- `dateSeparator`, `eol` (majority), `bom`, `finalNewline` (`true` for empty).
- `defaultCommodity`: `D` directive, else most common commodity.
- `commodities`: per commodity, side/spacing/marks from usage, *usual*
  (modal) precision; a `commodity` directive (or its `format` subdirective) is
  the declared style and wins — including its decimal mark, as in hledger.

## Rendering (`formatTxn(draft, style)`)

`DATE[=DATE2] [STATUS] [(CODE)] DESCRIPTION[  ; comment]`, then extra comment
lines as `INDENT; text`, then postings: `INDENT[STATUS ][(ACCOUNT)|[ACCOUNT]]`,
amount+cost right-aligned to the column with at least two spaces (two spaces
when the column is `null`), ` ASSERTION` (or `  ASSERTION` for an elided amount
— a balance assignment), `  ; comment`. A blank amount is written as a bare
account. Joined with the style's EOL, no trailing EOL.

Amounts: the typed number is read leniently against the commodity's decimal
mark (both marks → the last is decimal; a lone other mark with three digits
after it is grouping, otherwise it is the decimal mark the user meant), then
written with the commodity's decimal mark, digit grouping (groups of 3), and at
least its usual precision — **never rounded**. `commodity` undefined → the
style's default commodity; `''` → no commodity. Unknown commodities: symbols
(`$`, `€`) left, unspaced; codes right, spaced (or left-spaced if that is the
file's habit). Commodities needing it are quoted (`"VANGUARD FUND"`).

**Sign placement:** a left-side commodity takes the sign after the symbol,
`$-12.50`, which is how hledger itself prints amounts and what PocketLedger's
writer did; right-side is `-12.50 EUR`. Both `-$12.50` and `$-12.50` parse;
an existing `-$12.50` whose value does not change is kept as written.

`cost` without a leading `@`/`{` gets `@ `; `assertion` without `=` gets `= `.

## Validation

`validateDraft` reports what would corrupt the file's structure: invalid
dates, line breaks in one-line fields, `;` in the description, `)` in the
code, empty accounts or accounts with double spaces/tabs/`;`, brackets or
status markers written into the account. Balancing is left to hledger
(`engine.check` on the patched snapshot before saving).

## Fidelity guarantees (tested)

`tests/fidelity/writer.fidelity.test.ts` runs every fixture in
`tests/fixtures` and `tests/fixtures/writer` in five byte variants (as is,
CRLF, BOM+CRLF, BOM+LF, no final newline):

- the `locate` scanner agrees with an independent test scanner;
- no-op `planEdit` and no-op `planReplaceText` are `[]` for every transaction;
- fuzzed edits (description, amount, account, comment, add / remove posting)
  change only lines inside the span; single-field edits change exactly one
  line; the result reads back as the draft; EOL and BOM are preserved;
- delete then re-add (append and date-ordered) re-parses to the same draft,
  leaves every other transaction's text intact and adds no double blank lines;
- a batch edit of every transaction keeps every line outside the spans.

`tests/fidelity/hledger.test.ts` (skipped without `/home/user/dl/native/hledger`
or `$HLEDGER_BIN`) uses hledger 1.52's own `tsourcepos` spans, checks they
match the scanner and that no-op edits on them are byte-identical, then runs
batch edits + a dated insert + an append + a delete and proves hledger still
parses and balances the result.

## Contract notes

The contract is frozen; the writer works within it as follows (proposals are in
the phase report):

- `inferStyle` returns `InferredStyle`, a `JournalStyle` with
  `commodities: Record<string, CommodityStyle>` and `samples`. `formatTxn`
  uses `commodities` when present, so a plain `JournalStyle` still works (with
  the defaults above).
- Lots have no field in `PostingDraft`; they live in `cost` with the price.
- `planEdit` returns `[]` when nothing changes.
