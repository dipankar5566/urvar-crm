"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { inr } from "@/lib/constants/labels";
import { autoAllocate, toPaise } from "@/lib/receipt-allocation";
import { recordReceiptAction } from "../actions";

type CustomerOption = { id: string; name: string; customerNumber: string };
type AccountOption = { id: string; code: string; name: string };
type OpenInvoice = { id: string; invoiceNumber: string; totalAmount: number; outstanding: number };

const METHODS = ["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"] as const;

export function RecordReceiptForm({
  customers,
  depositAccounts,
}: {
  customers: CustomerOption[];
  depositAccounts: AccountOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [customerId, setCustomerId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [depositAccountId, setDepositAccountId] = useState(depositAccounts[0]?.id ?? "");
  const [receiptDate, setReceiptDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [loadingInvoices, setLoadingInvoices] = useState(false);

  // Which side the user is driving. Untouched, Amount mirrors the invoice
  // boxes (type ₹1,000 against an invoice and the receipt is ₹1,000). Once
  // they type an Amount it is the source of truth and the boxes auto-fill from
  // it, oldest invoice first, until they edit a box by hand — after which their
  // boxes are left alone.
  const [amountTouched, setAmountTouched] = useState(false);
  const [allocationsTouched, setAllocationsTouched] = useState(false);

  // Derived directly from customerId rather than reset in the effect below,
  // so switching customers clears the old list on the same render instead of
  // a following one, and the effect itself never needs a synchronous setState
  // on its "nothing to do" branch.
  const invoices = useMemo(() => (customerId ? openInvoices : []), [customerId, openInvoices]);

  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    // setTimeout, matching global-search.tsx's fetch-in-effect pattern: it
    // moves the state updates out of the effect's synchronous execution,
    // which both plays nicely with the set-state-in-effect lint rule and
    // means a fast customerId change doesn't fire two overlapping loads.
    const timeout = setTimeout(() => {
      setLoadingInvoices(true);
      fetch(`/api/customers/${customerId}/open-invoices`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: OpenInvoice[]) => {
          if (!cancelled) setOpenInvoices(rows);
        })
        .catch(() => {
          if (!cancelled) setOpenInvoices([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingInvoices(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [customerId]);

  const autoAllocations = useMemo(
    () => (amountTouched ? autoAllocate(Number(amount) || 0, invoices) : {}),
    [amountTouched, amount, invoices],
  );
  const shownAllocations = allocationsTouched ? allocations : autoAllocations;

  const allocatedPaise = Object.values(shownAllocations).reduce(
    (sum, v) => sum + toPaise(Number(v) || 0),
    0,
  );
  const allocatedTotal = allocatedPaise / 100;
  const effectiveAmount = amountTouched ? amount : allocatedTotal > 0 ? allocatedTotal.toFixed(2) : "";
  const amountNum = Number(effectiveAmount) || 0;
  const advance = Math.max(0, toPaise(amountNum) - allocatedPaise) / 100;
  const overAllocated = allocatedPaise > toPaise(amountNum);

  // Base UI's <SelectValue> can only resolve a label for items that are
  // mounted, and the list is unmounted while the dropdown is closed — so
  // without `items` on the root it prints the raw value (a cuid) in the
  // trigger. Passing value/label pairs is the supported fix.
  const customerItems = useMemo(
    () => customers.map((c) => ({ value: c.id, label: `${c.name} (${c.customerNumber})` })),
    [customers],
  );
  const accountItems = useMemo(
    () => depositAccounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })),
    [depositAccounts],
  );

  function onCustomerChange(id: string) {
    setCustomerId(id);
    setOpenInvoices([]);
    setAllocations({});
    setAllocationsTouched(false);
  }

  function onAmountChange(value: string) {
    setAmount(value);
    // Clearing the field hands control back to the boxes.
    setAmountTouched(value !== "");
  }

  function setAllocation(invoiceId: string, value: string) {
    // Seed from what's on screen so hand-editing one box doesn't wipe the
    // auto-filled others.
    setAllocations({ ...shownAllocations, [invoiceId]: value });
    setAllocationsTouched(true);
  }

  async function submit() {
    if (!customerId) return toast.error("Select a customer.");
    if (amountNum <= 0) return toast.error("Enter a valid amount.");
    if (!depositAccountId) return toast.error("Select where this was deposited.");
    if (overAllocated) {
      return toast.error(
        `Allocated ${inr(allocatedTotal)} is more than the amount received, ${inr(amountNum)}.`,
      );
    }
    const overInvoice = invoices.find(
      (inv) => toPaise(Number(shownAllocations[inv.id]) || 0) > toPaise(inv.outstanding),
    );
    if (overInvoice) {
      return toast.error(
        `${overInvoice.invoiceNumber} has only ${inr(overInvoice.outstanding)} outstanding.`,
      );
    }

    const allocationInputs = Object.entries(shownAllocations)
      .filter(([, v]) => Number(v) > 0)
      .map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) }));

    start(async () => {
      const result = await recordReceiptAction({
        customerId,
        receiptDate,
        amount: amountNum,
        method,
        reference: reference || undefined,
        depositAccountId,
        allocations: allocationInputs,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Receipt recorded.");
        router.push(`/receipts/${result.receiptId}`);
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Receipt</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>Customer</Label>
            <Select items={customerItems} value={customerId} onValueChange={(v) => onCustomerChange(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a customer" />
              </SelectTrigger>
              <SelectContent>
                {customerItems.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="amount">Amount (₹)</Label>
            <Input
              id="amount"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={effectiveAmount}
              onChange={(e) => onAmountChange(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="receiptDate">Date</Label>
            <Input id="receiptDate" type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as (typeof METHODS)[number])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Deposit To</Label>
            <Select items={accountItems} value={depositAccountId} onValueChange={(v) => setDepositAccountId(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {accountItems.map((a) => (
                  <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="reference">Reference (UTR / cheque no. / UPI ref)</Label>
            <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {customerId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Allocate to outstanding invoices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadingInvoices && <p className="text-sm text-muted-foreground">Loading…</p>}
            {!loadingInvoices && invoices.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No outstanding invoices for this customer — the full amount will be recorded as an
                on-account advance.
              </p>
            )}
            {invoices.map((inv) => {
              const alloc = Number(shownAllocations[inv.id]) || 0;
              return (
                <div key={inv.id} className="flex items-center justify-between gap-3 border-b pb-2 last:border-0">
                  <div className="text-sm">
                    <span className="font-mono">{inv.invoiceNumber}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      outstanding {inr(inv.outstanding)}
                    </span>
                    {alloc > 0 && (
                      <div className="text-xs text-muted-foreground">
                        {toPaise(alloc) >= toPaise(inv.outstanding)
                          ? "Fully paid by this receipt"
                          : `${inr(Math.max(0, inv.outstanding - alloc))} will remain outstanding`}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setAllocation(inv.id, inv.outstanding.toFixed(2))}
                    >
                      Full
                    </Button>
                    <Input
                      type="number"
                      min="0"
                      max={inv.outstanding}
                      step="0.01"
                      className="w-32"
                      placeholder="0.00"
                      value={shownAllocations[inv.id] ?? ""}
                      onChange={(e) => setAllocation(inv.id, e.target.value)}
                    />
                  </div>
                </div>
              );
            })}

            {invoices.length > 0 && (
              <div className="grid grid-cols-3 gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
                <div>
                  <div className="text-[11px] text-muted-foreground">Received</div>
                  <div className="font-semibold tabular-nums">{inr(amountNum)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Allocated to invoices</div>
                  <div className="font-semibold tabular-nums">{inr(allocatedTotal)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Advance</div>
                  <div className="font-semibold tabular-nums">{inr(advance)}</div>
                </div>
              </div>
            )}

            {overAllocated && (
              <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                Allocated {inr(allocatedTotal)} is more than the amount received, {inr(amountNum)}.
                Reduce an allocation or increase the amount.
              </p>
            )}

            {!overAllocated && advance > 0 && invoices.length > 0 && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                {inr(advance)} isn&apos;t allocated to any invoice and will be recorded as an advance
                from the customer. The invoices above stay unpaid to that extent.
              </p>
            )}
            {advance > 0 && invoices.length === 0 && (
              <p className="pt-2 text-sm text-muted-foreground">
                Unallocated {inr(advance)} will be recorded as an on-account advance.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending || overAllocated}>
          {pending ? "Recording…" : "Record Receipt"}
        </Button>
      </div>
    </div>
  );
}
