/**
 * Phase 4 of the sales-funnel automation roadmap (all.md): a read-only
 * classifier for the "safe zone" — small, standard-priced deals with a
 * known, in-good-standing customer — where a later phase could eventually
 * let the system act without a human waiting on the other end. This module
 * only ever answers "would this have qualified"; nothing here writes
 * anything or changes any behavior. See getSafeZoneReport in reports.ts for
 * where this is actually run against real data.
 */

const MAX_QUOTATION_VALUE = Number(process.env.SAFE_ZONE_MAX_QUOTATION_VALUE ?? 25000);

/** Anything with a numeric value and a toString — matches Prisma's Decimal
 * without importing its runtime type, so this module stays independent of
 * exactly which Decimal implementation the generated client uses. */
type Numeric = { toString(): string } | number;

function num(value: Numeric | null | undefined): number {
  if (value == null) return 0;
  return typeof value === "number" ? value : Number(value.toString());
}

export type SafeZoneCustomer = {
  customerType: string;
  dealerTier: string | null;
  creditLimit: Numeric | null;
  outstandingAmount: Numeric;
};

export type SafeZoneProduct = {
  mrp: Numeric;
  dealerPrice: Numeric | null;
  distributorPrice: Numeric | null;
};

export type SafeZoneQuotationItem = {
  productId: string;
  unitPrice: Numeric;
  discountPercent: Numeric;
};

export type SafeZoneQuotation = {
  discountPercent: Numeric;
  discountAmount: Numeric;
  totalAmount: Numeric;
  items: SafeZoneQuotationItem[];
};

export type SafeZoneClassification = {
  eligible: boolean;
  /** Populated only when not eligible — each reason is a specific,
   * human-readable failure so a business reviewer can sanity-check the
   * threshold against real deals rather than trust a bare true/false. */
  reasons: string[];
};

/** The price tier a customer is expected to pay, by type/tier — falls back
 * to MRP if the tier-specific price isn't set on the product (per
 * CLAUDE.md: dealerPrice/distributorPrice are both nullable). */
function expectedUnitPrice(product: SafeZoneProduct, customer: SafeZoneCustomer): number {
  if (customer.customerType === "B2B_DISTRIBUTOR") {
    return num(product.distributorPrice) || num(product.mrp);
  }
  if (customer.customerType === "B2B_DEALER" || customer.dealerTier) {
    return num(product.dealerPrice) || num(product.mrp);
  }
  return num(product.mrp);
}

export function classifyCustomerSafeZone(customer: SafeZoneCustomer): SafeZoneClassification {
  const reasons: string[] = [];
  if (!customer.dealerTier) reasons.push("No established dealer tier on file.");
  if (customer.creditLimit == null) {
    reasons.push("No credit limit on file.");
  } else if (num(customer.outstandingAmount) > num(customer.creditLimit)) {
    reasons.push("Outstanding amount exceeds credit limit.");
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Classifies one quotation against the safe-zone rule: standard pricing (no
 * discount, tier-correct unit prices), a known-good customer, and a
 * conservative value cap. Every failing check is reported, not just the
 * first, so the business can see how close/far a rejected deal actually was.
 */
export function classifyQuotationSafeZone(
  quotation: SafeZoneQuotation,
  customer: SafeZoneCustomer,
  products: Map<string, SafeZoneProduct>,
): SafeZoneClassification {
  const reasons: string[] = [...classifyCustomerSafeZone(customer).reasons];

  if (num(quotation.discountPercent) !== 0 || num(quotation.discountAmount) !== 0) {
    reasons.push("Quotation-level discount applied.");
  }

  for (const item of quotation.items) {
    if (num(item.discountPercent) !== 0) {
      reasons.push(`Line-level discount on a product.`);
      continue;
    }
    const product = products.get(item.productId);
    if (!product) {
      reasons.push("A line item's product could not be found.");
      continue;
    }
    const expected = expectedUnitPrice(product, customer);
    if (num(item.unitPrice) !== expected) {
      reasons.push(
        `A line item is priced off-standard (expected Rs ${expected.toFixed(2)}, quoted Rs ${num(item.unitPrice).toFixed(2)}).`,
      );
    }
  }

  if (num(quotation.totalAmount) > MAX_QUOTATION_VALUE) {
    reasons.push(
      `Total Rs ${num(quotation.totalAmount).toFixed(2)} exceeds the safe-zone cap of Rs ${MAX_QUOTATION_VALUE}.`,
    );
  }

  return { eligible: reasons.length === 0, reasons };
}
