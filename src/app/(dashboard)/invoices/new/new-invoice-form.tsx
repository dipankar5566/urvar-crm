"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { inr } from "@/lib/constants/labels";
import { createInvoiceAction } from "../actions";

type OrderLineOption = {
  id: string;
  description: string;
  unit: string;
  quantity: number;
  quantityInvoiced: number;
  remaining: number;
  unitPrice: number;
};

export function NewInvoiceForm({
  orderId,
  items,
  defaults,
}: {
  orderId: string;
  items: OrderLineOption[];
  defaults: { freightAmount: number; discountAmount: number; fromQuotation: string | null };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const invoiceable = items.filter((i) => i.remaining > 0);

  const [selected, setSelected] = useState<Record<string, boolean>>(
    Object.fromEntries(invoiceable.map((i) => [i.id, true])),
  );
  const [quantities, setQuantities] = useState<Record<string, string>>(
    Object.fromEntries(invoiceable.map((i) => [i.id, String(i.remaining)])),
  );
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [freightAmount, setFreightAmount] = useState(String(defaults.freightAmount));
  const [discountAmount, setDiscountAmount] = useState(String(defaults.discountAmount));
  const [notes, setNotes] = useState("");

  const estimatedSubtotal = useMemo(
    () =>
      invoiceable
        .filter((i) => selected[i.id])
        .reduce((sum, i) => sum + (Number(quantities[i.id]) || 0) * i.unitPrice, 0),
    [invoiceable, selected, quantities],
  );

  // Two different reasons for nothing to invoice. An order with no lines at
  // all used to fall through to "fully invoiced" (every() over an empty list
  // is true), which sent people hunting for an invoice that never existed.
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          This order has no line items, so there is nothing to invoice yet. Orders accepted
          from a quotation get their lines copied automatically; an older order may need its
          lines restored first — ask an administrator.
        </CardContent>
      </Card>
    );
  }
  if (invoiceable.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Every line on this order has already been fully invoiced.
        </CardContent>
      </Card>
    );
  }

  async function submit() {
    const lines = invoiceable
      .filter((i) => selected[i.id])
      .map((i) => ({ orderItemId: i.id, quantity: Number(quantities[i.id]) || undefined }));

    if (lines.length === 0) {
      toast.error("Select at least one line to invoice.");
      return;
    }

    start(async () => {
      const result = await createInvoiceAction({
        orderId,
        invoiceDate,
        dueDate: dueDate || undefined,
        lines,
        freightAmount: Number(freightAmount) || 0,
        discountAmount: Number(discountAmount) || 0,
        notes,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Invoice raised.");
        router.push(`/invoices/${result.invoiceId}`);
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines to invoice</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {invoiceable.map((item) => (
            <div key={item.id} className="flex items-center gap-3 border-b pb-3 last:border-0">
              <Checkbox
                checked={selected[item.id] ?? false}
                onCheckedChange={(v) => setSelected((s) => ({ ...s, [item.id]: Boolean(v) }))}
              />
              <div className="flex-1">
                <div className="text-sm font-medium">{item.description}</div>
                <div className="text-xs text-muted-foreground">
                  {item.remaining} of {item.quantity} remaining · {inr(item.unitPrice)} each
                </div>
              </div>
              <Input
                type="number"
                min="0"
                max={item.remaining}
                step="0.01"
                className="w-28"
                value={quantities[item.id]}
                disabled={!selected[item.id]}
                onChange={(e) => setQuantities((q) => ({ ...q, [item.id]: e.target.value }))}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="invoiceDate">Invoice Date</Label>
            <Input id="invoiceDate" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dueDate">Due Date</Label>
            <Input id="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="freightAmount">Freight (₹)</Label>
            <Input id="freightAmount" type="number" min="0" value={freightAmount} onChange={(e) => setFreightAmount(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="discountAmount">Discount (₹)</Label>
            <Input id="discountAmount" type="number" min="0" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} />
          </div>
          {defaults.fromQuotation && (defaults.freightAmount > 0 || defaults.discountAmount > 0) && (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Freight and discount pre-filled from quotation {defaults.fromQuotation}. Edit them if
              this invoice should bill differently.
            </p>
          )}
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <div className="text-sm text-muted-foreground">
            Estimated taxable value: <span className="font-medium text-foreground">{inr(estimatedSubtotal)}</span>{" "}
            (tax and rounding are calculated on the server from each product&apos;s verified GST rate)
          </div>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Raising…" : "Raise Invoice"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
