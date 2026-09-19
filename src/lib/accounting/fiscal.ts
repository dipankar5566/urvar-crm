/**
 * Indian financial-year arithmetic.
 *
 * An FY runs 1 April to 31 March and is named by its starting calendar year:
 * FY 2026-27 is stored as `2026`. Periods are the twelve months of that year
 * numbered 1-12 from April, so ordering by `periodNumber` is chronological
 * within the FY rather than the calendar year — which is why the number is
 * stored rather than derived from the month at read time.
 *
 * Dates are constructed in the server's local zone (this box runs IST, and
 * every user is in India). Boundaries are inclusive: a period runs from
 * 00:00:00.000 on its first day to 23:59:59.999 on its last.
 */

export const DEFAULT_FY_START_MONTH = 4; // April

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function assertFyStartMonth(m: number): void {
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error(`Financial year start month must be 1-12, got ${m}`);
  }
}

/** The FY a date falls in, named by its starting calendar year. */
export function financialYearOf(date: Date, fyStartMonth = DEFAULT_FY_START_MONTH): number {
  assertFyStartMonth(fyStartMonth);
  const month = date.getMonth() + 1;
  return month >= fyStartMonth ? date.getFullYear() : date.getFullYear() - 1;
}

/** 1-12, where 1 is the first month of the financial year (April by default). */
export function periodNumberOf(date: Date, fyStartMonth = DEFAULT_FY_START_MONTH): number {
  assertFyStartMonth(fyStartMonth);
  const month = date.getMonth() + 1;
  return ((month - fyStartMonth + 12) % 12) + 1;
}

/** "2026-27" — how an Indian FY is written on a document. */
export function financialYearLabel(financialYear: number, fyStartMonth = DEFAULT_FY_START_MONTH): string {
  if (fyStartMonth === 1) return String(financialYear);
  const end = (financialYear + 1) % 100;
  return `${financialYear}-${String(end).padStart(2, "0")}`;
}

export type PeriodBounds = {
  financialYear: number;
  periodNumber: number;
  label: string;
  startDate: Date;
  endDate: Date;
};

/** Inclusive bounds of one period. `periodNumber` is 1-12 from the FY start. */
export function periodBounds(
  financialYear: number,
  periodNumber: number,
  fyStartMonth = DEFAULT_FY_START_MONTH,
): PeriodBounds {
  assertFyStartMonth(fyStartMonth);
  if (!Number.isInteger(periodNumber) || periodNumber < 1 || periodNumber > 12) {
    throw new Error(`Period number must be 1-12, got ${periodNumber}`);
  }
  const zeroBased = fyStartMonth - 1 + (periodNumber - 1);
  const calendarYear = financialYear + Math.floor(zeroBased / 12);
  const calendarMonth = zeroBased % 12; // 0-11

  const startDate = new Date(calendarYear, calendarMonth, 1, 0, 0, 0, 0);
  // Day 0 of the next month is the last day of this one — no leap-year table.
  const endDate = new Date(calendarYear, calendarMonth + 1, 0, 23, 59, 59, 999);

  return {
    financialYear,
    periodNumber,
    label: `${MONTH_LABELS[calendarMonth]} ${calendarYear}`,
    startDate,
    endDate,
  };
}

/** All twelve periods of a financial year, in order. */
export function periodsForYear(
  financialYear: number,
  fyStartMonth = DEFAULT_FY_START_MONTH,
): PeriodBounds[] {
  return Array.from({ length: 12 }, (_, i) => periodBounds(financialYear, i + 1, fyStartMonth));
}
