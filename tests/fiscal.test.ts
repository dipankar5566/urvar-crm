import { describe, it, expect } from "vitest";
import {
  financialYearOf, periodNumberOf, financialYearLabel, periodBounds, periodsForYear,
} from "@/lib/accounting/fiscal";

const d = (y: number, m: number, day = 15) => new Date(y, m - 1, day, 12, 0, 0, 0);

describe("financialYearOf(): an Indian FY starts in April", () => {
  it("names the FY by its starting calendar year", () => {
    expect(financialYearOf(d(2026, 4, 1))).toBe(2026);
    expect(financialYearOf(d(2026, 12))).toBe(2026);
    expect(financialYearOf(d(2027, 3, 31))).toBe(2026);
    expect(financialYearOf(d(2027, 4, 1))).toBe(2027);
  });

  it("treats January-March as the previous financial year", () => {
    expect(financialYearOf(d(2026, 1))).toBe(2025);
    expect(financialYearOf(d(2026, 3))).toBe(2025);
  });

  it("honours a different FY start month", () => {
    expect(financialYearOf(d(2026, 6), 1)).toBe(2026);
  });
});

describe("periodNumberOf(): 1 is April", () => {
  it("numbers months from the FY start, not the calendar", () => {
    expect(periodNumberOf(d(2026, 4))).toBe(1);
    expect(periodNumberOf(d(2026, 5))).toBe(2);
    expect(periodNumberOf(d(2027, 1))).toBe(10);
    expect(periodNumberOf(d(2027, 3))).toBe(12);
  });

  it("orders chronologically within the FY, which is why it is stored", () => {
    const dates = [d(2027, 2), d(2026, 4), d(2026, 12), d(2026, 7)];
    const sorted = [...dates].sort((a, b) => periodNumberOf(a) - periodNumberOf(b));
    expect(sorted.map((x) => x.getMonth() + 1)).toEqual([4, 7, 12, 2]);
  });
});

describe("financialYearLabel()", () => {
  it("writes an FY the way a document does", () => {
    expect(financialYearLabel(2026)).toBe("2026-27");
    expect(financialYearLabel(2029)).toBe("2029-30");
    expect(financialYearLabel(2099)).toBe("2099-00");
  });

  it("collapses to a single year when the FY is the calendar year", () => {
    expect(financialYearLabel(2026, 1)).toBe("2026");
  });
});

describe("periodBounds()", () => {
  it("maps period 1 of FY2026 to April 2026", () => {
    const p = periodBounds(2026, 1);
    expect(p.label).toBe("Apr 2026");
    expect(p.startDate.getMonth()).toBe(3);
    expect(p.startDate.getDate()).toBe(1);
    expect(p.endDate.getDate()).toBe(30);
  });

  it("crosses into the next calendar year for periods 10-12", () => {
    const p = periodBounds(2026, 12);
    expect(p.label).toBe("Mar 2027");
    expect(p.endDate.getFullYear()).toBe(2027);
    expect(p.endDate.getDate()).toBe(31);
  });

  it("gets February right, including a leap year", () => {
    expect(periodBounds(2026, 11).endDate.getDate()).toBe(28);
    expect(periodBounds(2027, 11).endDate.getDate()).toBe(29);
  });

  it("ends a period at the last millisecond, so bounds are inclusive", () => {
    const p = periodBounds(2026, 1);
    expect(p.endDate.getHours()).toBe(23);
    expect(p.endDate.getMinutes()).toBe(59);
    expect(p.endDate.getMilliseconds()).toBe(999);
  });

  it("rejects a period number outside 1-12", () => {
    expect(() => periodBounds(2026, 0)).toThrow(/1-12/);
    expect(() => periodBounds(2026, 13)).toThrow(/1-12/);
  });
});

describe("periodsForYear()", () => {
  it("returns twelve contiguous periods with no gap or overlap", () => {
    const periods = periodsForYear(2026);
    expect(periods).toHaveLength(12);
    for (let i = 1; i < periods.length; i++) {
      const gapMs = periods[i].startDate.getTime() - periods[i - 1].endDate.getTime();
      expect(gapMs).toBe(1);
    }
    expect(periods[0].label).toBe("Apr 2026");
    expect(periods[11].label).toBe("Mar 2027");
  });
});
