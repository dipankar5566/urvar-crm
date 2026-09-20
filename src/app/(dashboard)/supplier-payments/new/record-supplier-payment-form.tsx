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
import { recordSupplierPaymentAction } from "../actions";

type SupplierOption = { id: string; name: string; supplierCode: string };
type AccountOption = { id: string; code: string; name: string };
type OpenInvoice = { id: string; invoiceNumber: string; totalAmount: number; outstanding: number };

const METHODS = ["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"] as const;

export function RecordSupplierPaymentForm({
  suppliers,
  paymentAccounts,
}: {
  suppliers: SupplierOption[];
  paymentAccounts: AccountOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [supplierId, setSupplierId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState(paymentAccounts[0]?.id ?? "");
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [loadingInvoices, setLoadingInvoices] = useState(false);

  const invoices = supplierId ? openInvoices : [];

  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    const timeout = setTimeout(() => {
      setLoadingInvoices(true);
      fetch(`/api/suppliers/${supplierId}/open-invoices`)
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
  }, [supplierId]);

  const allocatedTotal = useMemo(
    () => Object.values(allocations).reduce((sum, v) => sum + (Number(v) || 0), 0),
    [allocations],
  );
  const advance = Math.max(0, (Number(amount) || 0) - allocatedTotal);

  async function submit() {
    if (!supplierId) return toast.error("Select a supplier.");
    if (!amount || Number(amount) <= 0) return toast.error("Enter a valid amount.");
    if (!paymentAccountId) return toast.error("Select where this was paid from.");

    const allocationInputs = Object.entries(allocations)
      .filter(([, v]) => Number(v) > 0)
      .map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) }));

    start(async () => {
      const result = await recordSupplierPaymentAction({
        supplierId,
        paymentDate,
        amount: Number(amount),
        method,
        reference: reference || undefined,
        paymentAccountId,
        allocations: allocationInputs,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Payment recorded.");
        router.push(`/supplier-payments/${result.paymentId}`);
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payment</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>Supplier</Label>
            <Select value={supplierId} onValueChange={(v) => setSupplierId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Select a supplier" />
              </SelectTrigger>
              <SelectContent>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} ({s.supplierCode})
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
            <Label htmlFor="paymentDate">Date</Label>
            <Input id="paymentDate" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
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
            <Label>Paid From</Label>
            <Select value={paymentAccountId} onValueChange={(v) => setPaymentAccountId(v ?? "")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {paymentAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
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

      {supplierId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Allocate to outstanding invoices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadingInvoices && <p className="text-sm text-muted-foreground">Loading…</p>}
            {!loadingInvoices && invoices.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No outstanding invoices for this supplier — the full amount will be recorded as an
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
          {pending ? "Recording…" : "Record Payment"}
        </Button>
      </div>
    </div>
  );
}
