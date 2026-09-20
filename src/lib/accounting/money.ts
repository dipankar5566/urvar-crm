import { Prisma } from "@/generated/prisma/client";

/**
 * Decimal money layer.
 *
 * Every monetary column in this schema is already `NUMERIC(p,2)`, but until
 * now every *computation* feeding those columns ran in IEEE `number` and was
 * written unrounded, leaving Postgres to round on insert. That is survivable
 * for a quotation total; it is not survivable for a ledger, where a posting
 * is rejected unless debits equal credits exactly.
 *
 * So: no accounting code does arithmetic on `number`. It comes in through
 * `money()`, stays a Decimal throughout, and is rounded explicitly at the
 * points where a rounding decision is actually being made.
 *
 * `Prisma.Decimal` is decimal.js, re-exported by the generated client — no
 * extra dependency, and the same type Prisma hands back when reading a
 * Decimal column, so values round-trip without a conversion step.
 */

export type Money = Prisma.Decimal;

/** Anything we are willing to accept as money at a boundary. */
export type MoneyInput = Prisma.Decimal | string | number | null | undefined;

/** Round half away from zero — the convention Indian invoicing expects. */
const ROUND_HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

/** Paise. Every intermediate monetary value is held to this scale. */
export const MONEY_SCALE = 2;

export const ZERO: Money = new Prisma.Decimal(0);

/**
 * Coerce to Decimal. `null`/`undefined` become zero, because in this domain a
 * missing amount always means "nothing", never "unknown" — the nullable
 * columns that mean "unknown" (creditLimit) are read explicitly, not summed.
 *
 * A `number` input is stringified first: `new Decimal(0.1 + 0.2)` captures the
 * float error, `new Decimal("0.30000000000000004")` at least captures it
 * honestly, and `String(n)` gives JS's shortest round-trip representation.
 */
export function money(value: MoneyInput): Money {
  if (value === null || value === undefined) return ZERO;
  if (value instanceof Prisma.Decimal) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Not a finite amount: ${value}`);
    }
    return new Prisma.Decimal(String(value));
  }
  const trimmed = value.trim();
  if (trimmed === "") return ZERO;
  // Tolerate the shapes humans and OCR produce: "₹1,23,456.78", "(500)".
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[(),₹\s]/g, "");
  let d: Money;
  try {
    d = new Prisma.Decimal(cleaned);
  } catch {
    throw new Error(`Not a valid amount: ${value}`);
  }
  if (!d.isFinite()) throw new Error(`Not a finite amount: ${value}`);
  return negative ? d.negated() : d;
}

export const add = (a: MoneyInput, b: MoneyInput): Money => money(a).plus(money(b));
export const sub = (a: MoneyInput, b: MoneyInput): Money => money(a).minus(money(b));
export const mul = (a: MoneyInput, b: MoneyInput): Money => money(a).times(money(b));

export function div(a: MoneyInput, b: MoneyInput): Money {
  const divisor = money(b);
  if (divisor.isZero()) throw new Error("Division by zero in a monetary calculation");
  return money(a).dividedBy(divisor);
}

/** Sum a list at full precision. Round once at the end, not per element. */
export function sum(values: MoneyInput[]): Money {
  return values.reduce<Money>((acc, v) => acc.plus(money(v)), ZERO);
}

/** `percent` is a percentage, so 18 means 18%. */
export function percentOf(base: MoneyInput, percent: MoneyInput): Money {
  return money(base).times(money(percent)).dividedBy(100);
}

/** Round to paise. The only rounding most callers need. */
export function round(value: MoneyInput): Money {
  return money(value).toDecimalPlaces(MONEY_SCALE, ROUND_HALF_UP);
}

/**
 * Round to an arbitrary number of decimal places. Used where a rate or a
 * unit cost is stored at finer precision than money itself (e.g. a weighted
 * average cost, `Decimal(14,4)`) — rounding it explicitly here, once, is what
 * "no unrounded arithmetic feeding a Decimal column" actually means for a
 * column that isn't 2dp.
 */
export function roundToScale(value: MoneyInput, decimalPlaces: number): Money {
  return money(value).toDecimalPlaces(decimalPlaces, ROUND_HALF_UP);
}

/**
 * Round to whole rupees, and report the adjustment.
 *
 * A GST invoice's grand total is customarily rounded to the nearest rupee
 * with the difference shown as an explicit "Round Off" line. Returning both
 * halves keeps that line derived rather than re-computed somewhere else and
 * allowed to disagree.
 */
export function roundToRupee(value: MoneyInput): { rounded: Money; adjustment: Money } {
  const exact = round(value);
  const rounded = exact.toDecimalPlaces(0, ROUND_HALF_UP);
  return { rounded, adjustment: rounded.minus(exact) };
}

export const isZero = (v: MoneyInput): boolean => money(v).isZero();
export const isNegative = (v: MoneyInput): boolean => money(v).isNegative();
export const isPositive = (v: MoneyInput): boolean => money(v).greaterThan(0);
export const eq = (a: MoneyInput, b: MoneyInput): boolean => money(a).equals(money(b));
export const gt = (a: MoneyInput, b: MoneyInput): boolean => money(a).greaterThan(money(b));
export const gte = (a: MoneyInput, b: MoneyInput): boolean => money(a).greaterThanOrEqualTo(money(b));
export const lt = (a: MoneyInput, b: MoneyInput): boolean => money(a).lessThan(money(b));
export const lte = (a: MoneyInput, b: MoneyInput): boolean => money(a).lessThanOrEqualTo(money(b));
export const neg = (v: MoneyInput): Money => money(v).negated();
export const abs = (v: MoneyInput): Money => money(v).absoluteValue();
export const max = (a: MoneyInput, b: MoneyInput): Money => (gte(a, b) ? money(a) : money(b));
export const min = (a: MoneyInput, b: MoneyInput): Money => (lte(a, b) ? money(a) : money(b));

/** Fixed 2dp string — the form a Decimal column and a PDF both want. */
export function toAmountString(value: MoneyInput): string {
  return round(value).toFixed(MONEY_SCALE);
}

/**
 * Display formatting, Indian digit grouping (1,23,456.78).
 *
 * Shows paise only when there are paise to show. The pre-existing `inr()` in
 * `constants/labels.ts` pins `maximumFractionDigits: 0`, so a stored
 * ₹1,234.56 has been rendering as ₹1,235 — fine for a dashboard tile,
 * wrong for a ledger, and the reason this exists separately.
 */
export function formatInr(
  value: MoneyInput,
  opts: { alwaysPaise?: boolean; withSymbol?: boolean } = {},
): string {
  const { alwaysPaise = true, withSymbol = true } = opts;
  const rounded = round(value);
  return new Intl.NumberFormat("en-IN", {
    style: withSymbol ? "currency" : "decimal",
    currency: "INR",
    minimumFractionDigits: alwaysPaise ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(rounded.toNumber());
}
