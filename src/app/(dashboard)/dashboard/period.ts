import { endOfDay, startOfDay, startOfMonth, subDays } from "date-fns";
import { financialYearOf } from "@/lib/accounting/fiscal";

export type DashboardPeriodKey = "month" | "fy" | "30d";

export type DashboardPeriod = {
  key: DashboardPeriodKey;
  from: Date;
  to: Date;
  label: string;
};

export const DASHBOARD_PERIODS: { key: DashboardPeriodKey; label: string }[] = [
  { key: "month", label: "This month" },
  { key: "fy", label: "FY to date" },
  { key: "30d", label: "Last 30 days" },
];

/**
 * Resolves the `?period=` preset to a concrete range ending today. Anything
 * unrecognised falls back to "month" — the param is request-controlled, so it
 * is never trusted beyond picking one of three fixed ranges.
 */
export function parseDashboardPeriod(param: string | undefined): DashboardPeriod {
  const now = new Date();
  const to = endOfDay(now);

  switch (param) {
    case "fy": {
      // financialYearOf() returns the calendar year the FY starts in (1 April).
      const fyStartYear = financialYearOf(now);
      return {
        key: "fy",
        from: new Date(fyStartYear, 3, 1),
        to,
        label: "FY to date",
      };
    }
    case "30d":
      return {
        key: "30d",
        from: startOfDay(subDays(now, 29)),
        to,
        label: "Last 30 days",
      };
    default:
      return {
        key: "month",
        from: startOfMonth(now),
        to,
        label: "This month",
      };
  }
}
