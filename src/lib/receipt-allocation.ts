export type AllocatableInvoice = { id: string; outstanding: number };

export const toPaise = (n: number) => Math.round(n * 100);

/**
 * Splits `amount` across open invoices oldest-first, capped at each invoice's
 * balance, for the receipt form's "type the amount, boxes fill themselves"
 * behaviour. Callers pass invoices in the order they should be settled — the
 * open-invoices API returns them by invoice date ascending.
 *
 * Works in whole paise so the result carries no float dust (0.1 + 0.2) and
 * formats to exactly two decimals. Invoices that receive nothing are omitted.
 * Anything left over after the last invoice is simply not allocated; the form
 * shows it as an advance, and the server records it as one.
 *
 * This only proposes amounts for the UI. `recordReceipt()` re-validates every
 * allocation against the real outstanding balance regardless.
 */
export function autoAllocate(
  amount: number,
  invoices: AllocatableInvoice[],
): Record<string, string> {
  let remaining = toPaise(amount);
  const out: Record<string, string> = {};
  for (const inv of invoices) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, toPaise(inv.outstanding));
    if (take > 0) {
      out[inv.id] = (take / 100).toFixed(2);
      remaining -= take;
    }
  }
  return out;
}
