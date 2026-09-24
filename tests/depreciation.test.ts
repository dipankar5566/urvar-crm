import { describe, it, expect } from "vitest";
import { computeWdvCharge } from "@/lib/accounting/depreciation";
import { toAmountString, add } from "@/lib/accounting/money";

describe("computeWdvCharge()", () => {
  it("charge = opening × rate%", () => {
    const result = computeWdvCharge("100000", "15", "0");
    expect(toAmountString(result.amount)).toBe("15000.00");
    expect(toAmountString(result.closingWdv)).toBe("85000.00");
    expect(result.isFullyDepreciated).toBe(false);
  });

  it("a full run never depreciates below salvage value, and closes out exactly", () => {
    let opening = "100000";
    let totalCharged = "0";
    let isFullyDepreciated = false;
    for (let year = 0; year < 100 && !isFullyDepreciated; year++) {
      const result = computeWdvCharge(opening, "15", "5000");
      totalCharged = toAmountString(add(totalCharged, result.amount));
      opening = toAmountString(result.closingWdv);
      isFullyDepreciated = result.isFullyDepreciated;
      expect(Number(opening)).toBeGreaterThanOrEqual(5000 - 0.01); // never dips below salvage
    }
    expect(isFullyDepreciated).toBe(true);
    expect(opening).toBe("5000.00");
    expect(totalCharged).toBe("95000.00"); // cost 100000 - salvage 5000
  });

  it("returns zero charge once already at or below salvage value", () => {
    const result = computeWdvCharge("5000", "15", "5000");
    expect(toAmountString(result.amount)).toBe("0.00");
    expect(result.isFullyDepreciated).toBe(true);
  });

  it("closes out a sub-rupee remainder in one final charge rather than an endless tail", () => {
    // Engineer a case where the raw charge would leave < ₹1 depreciable.
    const result = computeWdvCharge("100.50", "1", "100"); // raw = 100.50*0.01 = 1.005 -> rounds to 1.01, remaining after would be -0.51 (already covers it)
    expect(toAmountString(result.closingWdv)).toBe("100.00");
    expect(result.isFullyDepreciated).toBe(true);
  });
});
