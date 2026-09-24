import { gt, money, round, sub, type Money, type MoneyInput } from "./money";

/**
 * Pure WDV (written-down value / reducing-balance) depreciation math — no
 * Prisma, no I/O, mirroring loan-schedule.ts's separation for the same
 * reason: testable without `withRollback` against a database that is
 * production.
 *
 * This is a PER-ASSET WDV register, not the Income Tax Act's block-of-assets
 * computation (which pools by class and applies a 180-day half-rate rule in
 * the year of acquisition). It must never be presented as a tax depreciation
 * schedule — same "no compliance claim" posture the GST registers already
 * take. See the Phase 9 plan's open questions for the accountant.
 */

export type WdvCharge = {
  amount: Money;
  closingWdv: Money;
  /** True once this charge brings the asset down to (or within a rupee of) salvage value. */
  isFullyDepreciated: boolean;
};

/**
 * One year's WDV charge: `openingWdv × rate%`, floored so the asset never
 * depreciates below `salvageValue`. When the remaining depreciable amount
 * after a normal charge would be under ₹1, this takes all of it instead —
 * a definable, testable stopping rule rather than an asymptote that leaves
 * a fraction of a rupee on the books forever.
 */
export function computeWdvCharge(
  openingWdv: MoneyInput,
  annualRatePercent: MoneyInput,
  salvageValue: MoneyInput = 0,
): WdvCharge {
  const opening = money(openingWdv);
  const salvage = money(salvageValue);
  const depreciableRemaining = sub(opening, salvage);

  if (!gt(depreciableRemaining, 0)) {
    return { amount: money(0), closingWdv: opening, isFullyDepreciated: true };
  }

  const raw = round(opening.times(money(annualRatePercent)).dividedBy(100));
  let amount = raw.greaterThan(depreciableRemaining) ? depreciableRemaining : raw;

  const remainingAfter = sub(depreciableRemaining, amount);
  if (remainingAfter.greaterThan(0) && remainingAfter.lessThan(money("1.00"))) {
    amount = depreciableRemaining; // close it out rather than leave a sub-rupee tail forever
  }

  const closingWdv = round(sub(opening, amount));
  return { amount, closingWdv, isFullyDepreciated: closingWdv.lessThanOrEqualTo(salvage) };
}
