import { add, div, gt, gte, money, round, sub, toAmountString, type Money, type MoneyInput } from "./money";

/**
 * Pure loan-amortisation math — no Prisma, no I/O, so it is testable without
 * `withRollback` even though the database it would otherwise touch is
 * production. Reducing-balance (EMI) only; see the Phase 9 plan for why a
 * flat-rate method is explicitly out of scope.
 *
 * The EMI itself is never computed by this module and stored — see
 * `suggestEmi()`'s own comment. Only the per-instalment split is derived,
 * which is the only math that has to be exactly right.
 */

export class LoanScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoanScheduleError";
  }
}

export type InstallmentSplit = {
  interest: Money;
  principal: Money;
  totalPaid: Money;
  /** True when this instalment closes the loan — see the module comment. */
  isFinal: boolean;
};

/**
 * Split one instalment into principal and interest against the loan's
 * current outstanding balance.
 *
 * The final instalment is defined as "whatever closes the balance", not the
 * EMI figure: whenever the EMI's principal component would meet or exceed
 * what's actually still outstanding, this caps principal at the outstanding
 * balance and marks `isFinal`. That is what guarantees the loan's ledger
 * account lands on exactly 0.00 — any rounding drift accumulated over the
 * life of the loan is absorbed here, in the one place a discrepancy has
 * nowhere left to hide, rather than left as a residual few paise forever.
 */
export function computeInstallmentSplit(
  outstandingPrincipal: MoneyInput,
  annualRatePercent: MoneyInput,
  emiAmount: MoneyInput,
): InstallmentSplit {
  const outstanding = money(outstandingPrincipal);
  if (!gt(outstanding, 0)) {
    throw new LoanScheduleError("This loan has no outstanding principal — it is already closed.");
  }

  const monthlyRate = div(money(annualRatePercent), 1200); // annual% / 100 / 12
  const interest = round(monthlyRate.times(outstanding));
  const emi = money(emiAmount);

  let principal = sub(emi, interest);
  let isFinal = false;
  if (gte(principal, outstanding)) {
    principal = outstanding;
    isFinal = true;
  }

  if (!gt(principal, 0)) {
    throw new LoanScheduleError(
      `An instalment of ${toAmountString(emi)} does not cover this period's interest of ` +
        `${toAmountString(interest)} — the loan would never amortise.`,
    );
  }

  return { interest, principal, totalPaid: isFinal ? add(principal, interest) : emi, isFinal };
}

/**
 * A textbook EMI, offered ONLY as a suggested default when creating a loan —
 * never stored, never used to generate the amortisation itself.
 * `Loan.emiAmount` is always the figure the lender actually quoted, entered
 * by the user; recomputing it here and disagreeing with the bank's own
 * schedule by a few paise (a different rounding or day-count convention)
 * would be worse than not offering a suggestion at all.
 *
 * `(1+r)^n` is a ratio, not money — computed with Prisma.Decimal's own
 * `.pow()` directly, never through `money.ts`'s paise-scale `round()` until
 * the very last step. `money.ts` deliberately has no `pow` of its own.
 */
export function suggestEmi(principal: MoneyInput, annualRatePercent: MoneyInput, tenureMonths: number): Money {
  if (!Number.isInteger(tenureMonths) || tenureMonths <= 0) {
    throw new LoanScheduleError("Tenure must be a positive whole number of instalments.");
  }
  const p = money(principal);
  const monthlyRate = div(money(annualRatePercent), 1200);
  if (monthlyRate.isZero()) return round(div(p, tenureMonths));

  const factor = monthlyRate.plus(1).pow(tenureMonths); // (1+r)^n
  const emi = p.times(monthlyRate).times(factor).dividedBy(factor.minus(1));
  return round(emi);
}
