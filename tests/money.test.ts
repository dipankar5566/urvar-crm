import { describe, it, expect } from "vitest";
import {
  money, add, sub, mul, div, sum, percentOf, round, roundToRupee,
  toAmountString, formatInr, isZero, gt, lt, neg, abs,
} from "@/lib/accounting/money";

describe("money(): coercion at the boundary", () => {
  it("parses strings, numbers and Decimals to the same value", () => {
    expect(toAmountString(money("123.45"))).toBe("123.45");
    expect(toAmountString(money(123.45))).toBe("123.45");
    expect(toAmountString(money(money("123.45")))).toBe("123.45");
  });

  it("treats null, undefined and blank as zero", () => {
    expect(isZero(money(null))).toBe(true);
    expect(isZero(money(undefined))).toBe(true);
    expect(isZero(money("   "))).toBe(true);
  });

  it("tolerates the shapes humans and OCR actually produce", () => {
    expect(toAmountString(money("Rs 1,23,456.78".replace("Rs ", "")))).toBe("123456.78");
    expect(toAmountString(money("(500)"))).toBe("-500.00");
    expect(toAmountString(money(" 1,000 "))).toBe("1000.00");
  });

  it("rejects garbage rather than silently returning zero", () => {
    expect(() => money("abc")).toThrow(/not a valid amount/i);
    expect(() => money(Number.NaN)).toThrow(/finite/i);
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
  });
});

describe("arithmetic is exact, unlike the float maths it replaces", () => {
  it("0.1 + 0.2 === 0.3", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(add("0.1", "0.2").equals(money("0.3"))).toBe(true);
  });

  it("sums a long list without drift", () => {
    const tenPaise = Array.from({ length: 1000 }, () => "0.10");
    expect(toAmountString(sum(tenPaise))).toBe("100.00");
  });

  it("does the four operations", () => {
    expect(toAmountString(add(10, 5))).toBe("15.00");
    expect(toAmountString(sub(10, 5))).toBe("5.00");
    expect(toAmountString(mul(10, 5))).toBe("50.00");
    expect(toAmountString(div(10, 4))).toBe("2.50");
  });

  it("refuses to divide by zero instead of yielding Infinity", () => {
    expect(() => div(10, 0)).toThrow(/division by zero/i);
  });

  it("compares, negates and absolutes", () => {
    expect(gt("10.01", "10.00")).toBe(true);
    expect(lt("-1", "0")).toBe(true);
    expect(toAmountString(neg("5"))).toBe("-5.00");
    expect(toAmountString(abs("-5"))).toBe("5.00");
  });
});

describe("percentOf(): GST and discount maths", () => {
  it("takes a percentage, not a fraction", () => {
    expect(toAmountString(percentOf(1000, 18))).toBe("180.00");
    expect(toAmountString(percentOf(1000, 5))).toBe("50.00");
    expect(toAmountString(percentOf(1000, 2.5))).toBe("25.00");
  });

  it("keeps full precision until an explicit round", () => {
    const raw = percentOf("350.55", 5);
    expect(raw.toString()).toBe("17.5275");
    expect(toAmountString(raw)).toBe("17.53");
  });
});

describe("rounding", () => {
  it("rounds half away from zero, the Indian invoicing convention", () => {
    expect(toAmountString(round("0.005"))).toBe("0.01");
    expect(toAmountString(round("0.015"))).toBe("0.02");
    expect(toAmountString(round("-0.005"))).toBe("-0.01");
  });

  it("roundToRupee reports the adjustment so the round-off line is derived", () => {
    const a = roundToRupee("1234.56");
    expect(a.rounded.toString()).toBe("1235");
    expect(toAmountString(a.adjustment)).toBe("0.44");

    const b = roundToRupee("1234.20");
    expect(b.rounded.toString()).toBe("1234");
    expect(toAmountString(b.adjustment)).toBe("-0.20");
  });

  it("rounded total minus adjustment reverses back to the exact amount", () => {
    for (const v of ["1234.56", "0.49", "0.50", "99.99", "1000.00"]) {
      const { rounded, adjustment } = roundToRupee(v);
      expect(toAmountString(sub(rounded, adjustment))).toBe(toAmountString(money(v)));
    }
  });
});

describe("formatInr(): Indian digit grouping", () => {
  it("groups lakhs the Indian way, not in thousands", () => {
    expect(formatInr("123456.78")).toContain("1,23,456.78");
  });

  it("shows paise by default, because the stored column has them", () => {
    expect(formatInr("1234.50")).toContain("1,234.50");
  });

  it("can drop trailing paise for dashboard tiles", () => {
    expect(formatInr("1234.00", { alwaysPaise: false })).toContain("1,234");
    expect(formatInr("1234.00", { alwaysPaise: false })).not.toContain(".00");
  });
});
