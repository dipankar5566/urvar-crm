import { describe, it, expect } from "vitest";
import { autoAllocate } from "@/lib/receipt-allocation";

const inv = (id: string, outstanding: number) => ({ id, outstanding });

describe("autoAllocate(): oldest-first split for the receipt form", () => {
  it("puts a part-payment entirely on the oldest invoice", () => {
    expect(autoAllocate(1000, [inv("a", 2494), inv("b", 500)])).toEqual({ a: "1000.00" });
  });

  it("settles the oldest invoice in full and carries the rest to the next", () => {
    expect(autoAllocate(2800, [inv("a", 2494), inv("b", 500)])).toEqual({ a: "2494.00", b: "306.00" });
  });

  it("caps at each balance and leaves the excess unallocated (it becomes an advance)", () => {
    const out = autoAllocate(9999, [inv("a", 2494), inv("b", 500)]);
    expect(out).toEqual({ a: "2494.00", b: "500.00" });
  });

  it("allocates nothing for a zero, negative or empty amount", () => {
    expect(autoAllocate(0, [inv("a", 100)])).toEqual({});
    expect(autoAllocate(-5, [inv("a", 100)])).toEqual({});
    expect(autoAllocate(100, [])).toEqual({});
  });

  it("skips an invoice with nothing outstanding", () => {
    expect(autoAllocate(100, [inv("a", 0), inv("b", 300)])).toEqual({ b: "100.00" });
  });

  it("carries no float dust: 0.1 + 0.2 style amounts come out to exact paise", () => {
    // 0.1 + 0.2 = 0.30000000000000004 in floats
    expect(autoAllocate(0.3, [inv("a", 0.1), inv("b", 0.2)])).toEqual({ a: "0.10", b: "0.20" });
    expect(autoAllocate(1050.1, [inv("a", 1050.1)])).toEqual({ a: "1050.10" });
  });
});
