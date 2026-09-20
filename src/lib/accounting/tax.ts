import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { add, gt, money, mul, percentOf, round, sub, sum, type Money, type MoneyInput } from "./money";

/**
 * GST resolution: place of supply, the CGST/SGST vs IGST split, and per-line
 * tax from a verified `TaxRate` row.
 *
 * Deliberately never invents a rate. `TaxRate.isVerified` defaults false, and
 * every function here refuses to price a line from a row that has not been
 * signed off by a tax professional — the brief's rule that GST treatment is
 * never assumed, enforced in code rather than left as a comment.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export class TaxRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxRateError";
  }
}

/**
 * Intra-state (CGST+SGST) if the two states match, inter-state (IGST)
 * otherwise. Compared as normalised strings — "West Bengal" vs "west bengal "
 * must not silently fall through to IGST because of casing or a trailing
 * space, since that changes which government the tax is owed to.
 */
export function isInterState(sellerState: string, placeOfSupply: string): boolean {
  return normalizeState(sellerState) !== normalizeState(placeOfSupply);
}

function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

/**
 * Place of supply for a domestic sale is the customer's state — the delivery
 * address if one is on record for this sale, otherwise the customer's billing
 * state. Urvar's Customer model has one address field, not separate
 * billing/shipping, so today these are always the same; the parameter exists
 * so a future shipping address does not require touching every call site.
 */
export function resolvePlaceOfSupply(customerState: string): string {
  const trimmed = customerState.trim();
  if (!trimmed) throw new TaxRateError("Customer has no state on file — cannot determine place of supply.");
  return trimmed;
}

export type ResolvedRate = {
  hsnCode: string;
  ratePercent: Money;
  cessPercent: Money;
  treatment: string;
};

/**
 * Look up the verified rate effective on `asOf` for an HSN code.
 *
 * Throws — never falls back to a default — when no verified row covers the
 * date. An unpriced line is a blocked invoice, not a silently wrong one.
 */
export async function resolveTaxRate(hsnCode: string, asOf: Date, db: Db = prisma): Promise<ResolvedRate> {
  const rate = await db.taxRate.findFirst({
    where: {
      hsnCode,
      isVerified: true,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
  if (!rate) {
    throw new TaxRateError(
      `No verified GST rate for HSN ${hsnCode} as of ${asOf.toISOString().slice(0, 10)}. ` +
        `An accountant must verify a TaxRate row before this product can be invoiced.`,
    );
  }
  return {
    hsnCode: rate.hsnCode,
    ratePercent: money(rate.ratePercent),
    cessPercent: money(rate.cessPercent),
    treatment: rate.treatment,
  };
}

export type TaxSplit = {
  cgst: Money;
  sgst: Money;
  igst: Money;
  cess: Money;
  /** Sum of all four — the total tax on this taxable value. */
  total: Money;
};

/**
 * Split tax on a taxable value given a resolved rate and whether the supply
 * is inter-state. Rounds each component independently to paise, which is the
 * standard invoicing convention and is why CGST+SGST can differ from IGST at
 * the same nominal rate by a paisa on an odd taxable value — both are correct.
 */
export function splitTax(taxableValue: MoneyInput, rate: ResolvedRate, interState: boolean): TaxSplit {
  const cess = round(percentOf(taxableValue, rate.cessPercent));
  if (interState) {
    const igst = round(percentOf(taxableValue, rate.ratePercent));
    return { cgst: money(0), sgst: money(0), igst, cess, total: add(igst, cess) };
  }
  const half = money(rate.ratePercent).dividedBy(2);
  const cgst = round(percentOf(taxableValue, half));
  const sgst = round(percentOf(taxableValue, half));
  return { cgst, sgst, igst: money(0), cess, total: sum([cgst, sgst, cess]) };
}

export type PricedLine = {
  quantity: Money;
  unitPrice: Money;
  discountPercent: Money;
  taxableValue: Money;
  taxRatePercent: Money;
  cgstAmount: Money;
  sgstAmount: Money;
  igstAmount: Money;
  cessAmount: Money;
  lineTotal: Money;
};

/**
 * Price one invoice line end to end: discount off the gross, tax on the net,
 * total including tax. All Decimal, all the way through.
 */
export function priceLine(
  input: { quantity: MoneyInput; unitPrice: MoneyInput; discountPercent?: MoneyInput },
  rate: ResolvedRate,
  interState: boolean,
): PricedLine {
  const quantity = money(input.quantity);
  const unitPrice = money(input.unitPrice);
  const discountPercent = money(input.discountPercent ?? 0);

  if (!gt(quantity, 0)) throw new TaxRateError("Line quantity must be greater than zero.");

  const gross = mul(quantity, unitPrice);
  const discount = percentOf(gross, discountPercent);
  const taxableValue = round(sub(gross, discount));

  const tax = splitTax(taxableValue, rate, interState);

  return {
    quantity,
    unitPrice,
    discountPercent,
    taxableValue,
    taxRatePercent: rate.ratePercent,
    cgstAmount: tax.cgst,
    sgstAmount: tax.sgst,
    igstAmount: tax.igst,
    cessAmount: tax.cess,
    lineTotal: round(add(taxableValue, tax.total)),
  };
}
