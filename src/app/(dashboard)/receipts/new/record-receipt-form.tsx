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

  // Derived directly from customerId rather than reset in the effect below,
  // so switching customers clears the old list on the same render instead of
  // a following one, and the effect itself never needs a synchronous setState
  // on its "nothing to do" branch.
  const invoices = customerId ? openInvoices : [];

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

  const allocatedTotal = useMemo(
    () => Object.values(allocations).reduce((sum, v) => sum + (Number(v) || 0), 0),
    [allocations],
  );
  const advance = Math.max(0, (Number(amount) || 0) - allocatedTotal);

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

  async function submit() {
    if (!customerId) return toast.error("Select a customer.");
    if (!amount || Number(amount) <= 0) return toast.error("Enter a valid amount.");
    if (!depositAccountId) return toast.error("Select where this was deposited.");

    const allocationInputs = Object.entries(allocations)
      .filter(([, v]) => Number(v) > 0)
      .map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) }));

    start(async () => {
      const result = await recordReceiptAction({
        customerId,
        receiptDate,
        amount: Number(amount),
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
            <Select items={customerItems} value={customerId} onValueChange={(v) => setCustomerId(v ?? "")}>
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
            <Input id="amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
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
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between gap-3 border-b pb-2 last:border-0">
                <div className="text-sm">
                  <span className="font-mono">{inv.invoiceNumber}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    outstanding {inr(inv.outstanding)}
                  </span>
                </div>
                <Input
                  type="number"
                  min="0"
                  max={inv.outstanding}
                  step="0.01"
                  className="w-32"
                  value={allocations[inv.id] ?? ""}
                  onChange={(e) => setAllocations((a) => ({ ...a, [inv.id]: e.target.value }))}
                />
              </div>
            ))}
            {advance > 0 && (
              <p className="pt-2 text-sm text-muted-foreground">
                Unallocated {inr(advance)} will be recorded as an on-account advance.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Recording…" : "Record Receipt"}
        </Button>
      </div>
    </div>
  );
}
