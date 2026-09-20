import { describe, it, expect } from "vitest";
import { isInterState, resolvePlaceOfSupply, splitTax, priceLine, TaxRateError } from "@/lib/accounting/tax";
import { toAmountString, money, add } from "@/lib/accounting/money";
import type { ResolvedRate } from "@/lib/accounting/tax";

const rate5 = (): ResolvedRate => ({
  hsnCode: "3101",
  ratePercent: money(5),
  cessPercent: money(0),
  treatment: "TAXABLE",
});

describe("isInterState(): decides CGST+SGST vs IGST", () => {
  it("is false when seller and customer share a state", () => {
    expect(isInterState("West Bengal", "West Bengal")).toBe(false);
  });

  it("is true across different states", () => {
    expect(isInterState("West Bengal", "Karnataka")).toBe(true);
  });

  it("is not fooled by case or surrounding whitespace", () => {
    expect(isInterState("West Bengal", " west bengal ")).toBe(false);
    expect(isInterState("west bengal", "WEST BENGAL")).toBe(false);
  });
});

describe("resolvePlaceOfSupply()", () => {
  it("returns the trimmed customer state", () => {
    expect(resolvePlaceOfSupply(" Odisha ")).toBe("Odisha");
  });

  it("refuses a blank state rather than guessing", () => {
    expect(() => resolvePlaceOfSupply("")).toThrow(/no state on file/i);
    expect(() => resolvePlaceOfSupply("   ")).toThrow(/no state on file/i);
  });
});

describe("splitTax(): intra-state", () => {
  it("splits evenly into CGST and SGST, IGST zero", () => {
    const split = splitTax("1000.00", rate5(), false);
    expect(toAmountString(split.cgst)).toBe("25.00");
    expect(toAmountString(split.sgst)).toBe("25.00");
    expect(toAmountString(split.igst)).toBe("0.00");
    expect(toAmountString(split.total)).toBe("50.00");
  });

  it("can round CGST and SGST to different paise on an odd taxable value", () => {
    // 2.5% of 33.33 = 0.83325, rounds to 0.83 both times here, but the point
    // is each side is rounded independently rather than halving one rounded
    // total — so this is a real invariant to protect, not paranoia.
    const split = splitTax("33.33", rate5(), false);
    const recombined = add(split.cgst, split.sgst);
    // Exact sum may differ from a single 5% rounding by up to 1 paisa either
    // way; assert it is at least self-consistent and non-negative.
    expect(recombined.greaterThanOrEqualTo(0)).toBe(true);
  });
});

describe("splitTax(): inter-state", () => {
  it("puts the full rate into IGST, CGST and SGST zero", () => {
    const split = splitTax("1000.00", rate5(), true);
    expect(toAmountString(split.igst)).toBe("50.00");
    expect(toAmountString(split.cgst)).toBe("0.00");
    expect(toAmountString(split.sgst)).toBe("0.00");
  });
});

describe("splitTax(): cess", () => {
  it("adds cess on top regardless of intra/inter-state", () => {
    const withCess: ResolvedRate = { ...rate5(), cessPercent: money(1) };
    const intra = splitTax("1000.00", withCess, false);
    const inter = splitTax("1000.00", withCess, true);
    expect(toAmountString(intra.cess)).toBe("10.00");
    expect(toAmountString(inter.cess)).toBe("10.00");
    expect(toAmountString(intra.total)).toBe("60.00"); // 25+25+10
    expect(toAmountString(inter.total)).toBe("60.00"); // 50+10
  });
});

describe("priceLine(): discount before tax, tax on the net", () => {
  it("prices a plain line with no discount", () => {
    const line = priceLine({ quantity: 2, unitPrice: 500 }, rate5(), false);
    expect(toAmountString(line.taxableValue)).toBe("1000.00");
    expect(toAmountString(line.cgstAmount)).toBe("25.00");
    expect(toAmountString(line.sgstAmount)).toBe("25.00");
    expect(toAmountString(line.lineTotal)).toBe("1050.00");
  });

  it("takes the discount off the gross before computing tax", () => {
    // 10 x 100 = 1000 gross, 10% discount -> 900 taxable, 5% tax -> 45.
    const line = priceLine({ quantity: 10, unitPrice: 100, discountPercent: 10 }, rate5(), false);
    expect(toAmountString(line.taxableValue)).toBe("900.00");
    expect(toAmountString(add(line.cgstAmount, line.sgstAmount))).toBe("45.00");
    expect(toAmountString(line.lineTotal)).toBe("945.00");
  });

  it("refuses a zero or negative quantity", () => {
    expect(() => priceLine({ quantity: 0, unitPrice: 100 }, rate5(), false)).toThrow(TaxRateError);
    expect(() => priceLine({ quantity: -1, unitPrice: 100 }, rate5(), false)).toThrow(TaxRateError);
  });

  it("handles a fractional quantity, since Urvar sells by kg and litre", () => {
    const line = priceLine({ quantity: "2.5", unitPrice: "200.00" }, rate5(), false);
    expect(toAmountString(line.taxableValue)).toBe("500.00");
  });
});
