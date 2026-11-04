import type {
  BalanceReport,
  BudgetCell,
  BudgetReport,
  PeriodicReport,
  ReportColumn,
  StatementReport,
} from '../../contracts/engine';
import { decodeMixed, type HAmount } from './amount';

type HDate = { tag: 'Exact' | 'Flex'; contents: string } | null;
export type HBalanceRow = [string, string, number, HAmount[]];
export type HBalanceReport = [HBalanceRow[], HAmount[]];

export function decodeBalance(r: HBalanceReport): BalanceReport {
  const [rows, total] = r;
  return {
    rows: rows.map(([account, displayName, indent, amount]) => ({ account, displayName, indent, amount: decodeMixed(amount) })),
    total: decodeMixed(total),
  };
}

export interface HPeriodicRow<A> {
  prrName: string | string[];
  prrAmounts: A[];
  prrTotal: A;
  prrAverage: A;
}
export interface HPeriodicReport<A = HAmount[]> {
  prDates: [HDate, HDate][];
  prRows: HPeriodicRow<A>[];
  prTotals: HPeriodicRow<A>;
}

const day = (d: HDate) => (d ? d.contents : '');
export const decodeColumns = (dates: [HDate, HDate][]): ReportColumn[] =>
  dates.map(([b, e]) => ({ begin: day(b), end: day(e) }));

const rowName = (n: string | string[]) => (Array.isArray(n) ? n.join(':') : n);
const depthOf = (name: string) => (name.startsWith('<') ? 1 : name.split(':').length);

export function decodePeriodic(r: HPeriodicReport): PeriodicReport {
  return {
    columns: decodeColumns(r.prDates),
    rows: r.prRows.map((row) => {
      const account = rowName(row.prrName);
      return {
        account,
        depth: depthOf(account),
        amounts: row.prrAmounts.map(decodeMixed),
        total: decodeMixed(row.prrTotal),
        average: decodeMixed(row.prrAverage),
      };
    }),
    totals: {
      amounts: r.prTotals.prrAmounts.map(decodeMixed),
      total: decodeMixed(r.prTotals.prrTotal),
      average: decodeMixed(r.prTotals.prrAverage),
    },
  };
}

export interface HCompoundReport {
  cbrTitle: string;
  cbrDates: [HDate, HDate][];
  cbrSubreports: [string, HPeriodicReport, boolean][];
  cbrTotals: HPeriodicRow<HAmount[]>;
}

export function decodeStatement(r: HCompoundReport): StatementReport {
  return {
    title: r.cbrTitle,
    columns: decodeColumns(r.cbrDates),
    sections: r.cbrSubreports.map(([title, report, increasesTotal]) => ({
      title,
      increasesTotal,
      report: decodePeriodic(report),
    })),
    totals: {
      amounts: r.cbrTotals.prrAmounts.map(decodeMixed),
      total: decodeMixed(r.cbrTotals.prrTotal),
      average: decodeMixed(r.cbrTotals.prrAverage),
    },
  };
}

type HBudgetCell = [HAmount[], HAmount[] | null];
const cell = ([actual, budget]: HBudgetCell): BudgetCell => ({
  actual: decodeMixed(actual),
  budget: budget == null ? null : decodeMixed(budget),
});

export function decodeBudget(r: HPeriodicReport<HBudgetCell>): BudgetReport {
  return {
    columns: decodeColumns(r.prDates),
    rows: r.prRows.map((row) => {
      const account = rowName(row.prrName);
      return { account, depth: depthOf(account), cells: row.prrAmounts.map(cell), total: cell(row.prrTotal), average: cell(row.prrAverage) };
    }),
    totals: { cells: r.prTotals.prrAmounts.map(cell), total: cell(r.prTotals.prrTotal), average: cell(r.prTotals.prrAverage) },
  };
}
