import { describe, it, expect } from "vitest";
import { computeInstallmentSplit, suggestEmi, LoanScheduleError } from "@/lib/accounting/loan-schedule";
import { toAmountString, add } from "@/lib/accounting/money";

describe("computeInstallmentSplit()", () => {
  it("a full amortisation run closes the loan to exactly zero — the headline drift test", async () => {
    // A paisa-rounded EMI does not always close a loan in EXACTLY the
    // nominal tenure — real bank schedules have this same property, which is
    // exactly why the final instalment is defined as "whatever closes the
    // balance" rather than assumed to land on period N. This loops until
    // isFinal, capped well past 60 as a sanity bound, not a hardcoded count.
    const principal = "500000";
    const annualRate = "9.5";
    const emi = suggestEmi(principal, annualRate, 60);

    let outstanding = principal;
    let totalPrincipal = "0";
    let periods = 0;
    let isFinal = false;
    while (!isFinal && periods < 65) {
      const split = computeInstallmentSplit(outstanding, annualRate, emi);
      totalPrincipal = toAmountString(add(totalPrincipal, split.principal));
      outstanding = toAmountString(split.principal.negated().plus(outstanding));
      isFinal = split.isFinal;
      periods++;
      if (!isFinal) expect(toAmountString(split.totalPaid)).toBe(toAmountString(emi));
    }
    expect(isFinal).toBe(true);
    expect(periods).toBeGreaterThanOrEqual(59);
    expect(periods).toBeLessThanOrEqual(61); // a paisa-rounded EMI drifts by at most one period
    expect(totalPrincipal).toBe("500000.00");
    expect(outstanding).toBe("0.00");
  });

  it("an EMI one rupee below correct still closes to exactly zero — the final instalment absorbs all drift", () => {
    const principal = "500000";
    const annualRate = "9.5";
    const correctEmi = suggestEmi(principal, annualRate, 60);
    const slightlyLowEmi = toAmountString(add(correctEmi, "-1"));

    let outstanding = principal;
    let lastSplit;
    for (let i = 1; i <= 200 && outstanding !== "0.00"; i++) {
      lastSplit = computeInstallmentSplit(outstanding, annualRate, slightlyLowEmi);
      outstanding = toAmountString(lastSplit.principal.negated().plus(outstanding));
      if (lastSplit.isFinal) break;
    }
    expect(outstanding).toBe("0.00");
    expect(lastSplit!.isFinal).toBe(true);
  });

  it("refuses an instalment that doesn't cover the first period's interest", () => {
    expect(() => computeInstallmentSplit("500000", "9.5", "100")).toThrow(LoanScheduleError);
  });

  it("a hand-checkable tiny loan: P=1000, 12% annual — first instalment's interest is exact", () => {
    // Monthly rate = 1%. EMI (textbook, rounded to paise) ≈ 340.02.
    const emi = suggestEmi("1000", "12", 3);
    const split1 = computeInstallmentSplit("1000", "12", emi);
    // Month 1: interest = 1000 * 1% = 10.00, exact — hand-checkable independent of rounding drift.
    expect(toAmountString(split1.interest)).toBe("10.00");

    // Confirm the loan still closes exactly, however many periods a
    // paisa-rounded 3-month EMI actually takes (see the test above for why
    // that isn't necessarily exactly 3).
    let outstanding = "1000";
    let isFinal = false;
    for (let i = 0; i < 10 && !isFinal; i++) {
      const split = computeInstallmentSplit(outstanding, "12", emi);
      outstanding = toAmountString(split.principal.negated().plus(outstanding));
      isFinal = split.isFinal;
    }
    expect(outstanding).toBe("0.00");
  });

  it("the final instalment's totalPaid may differ from the EMI (the residual, not the formula)", () => {
    const split = computeInstallmentSplit("50", "12", "1000"); // wildly overpaying, closes immediately
    expect(split.isFinal).toBe(true);
    expect(toAmountString(split.principal)).toBe("50.00");
    expect(toAmountString(split.totalPaid)).not.toBe("1000.00");
  });
});

describe("suggestEmi()", () => {
  it("zero-interest loan splits principal evenly", () => {
    const emi = suggestEmi("1200", "0", 12);
    expect(toAmountString(emi)).toBe("100.00");
  });

  it("refuses a non-positive tenure", () => {
    expect(() => suggestEmi("1000", "10", 0)).toThrow(LoanScheduleError);
  });
});
