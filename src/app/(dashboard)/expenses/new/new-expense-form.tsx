"use client";

import { useState, useTransition, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PlusIcon, TrashIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { createExpenseAction, uploadExpenseAttachmentAction } from "../actions";

type AccountOption = { id: string; code: string; name: string };
const METHODS = ["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"] as const;
const TAX_RATES = ["0", "5", "12", "18", "28"];

type ItemRow = { description: string; quantity: string; unitPrice: string; taxRatePercent: string };
const emptyRow = (): ItemRow => ({ description: "", quantity: "1", unitPrice: "", taxRatePercent: "0" });

const inr = (value: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value);

/**
 * Line items, GST, transportation and round-off, an attached receipt — the
 * itemised shape createExpense() supports alongside the older flat-amount
 * path. This form always submits `items` (never the legacy bare `amount`):
 * a one-line entry with quantity 1 covers the old "just an amount" case with
 * no separate mode toggle needed. All totals shown here are a client-side
 * preview only — createExpense() recomputes and rounds server-side, which is
 * what's actually posted.
 */
export function NewExpenseForm({
  categories,
  paymentAccounts,
}: {
  categories: AccountOption[];
  paymentAccounts: AccountOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [attaching, setAttaching] = useState(false);

  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [categoryAccountId, setCategoryAccountId] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("CASH");
  const [paymentAccountId, setPaymentAccountId] = useState(paymentAccounts[0]?.id ?? "");

  const [isGstApplicable, setIsGstApplicable] = useState(false);
  const [claimInputCredit, setClaimInputCredit] = useState(false);
  const [items, setItems] = useState<ItemRow[]>([emptyRow()]);
  const [transportAmount, setTransportAmount] = useState("0");
  const [fileId, setFileId] = useState<string | undefined>(undefined);
  const [fileName, setFileName] = useState<string | undefined>(undefined);

  function setRow(index: number, patch: Partial<ItemRow>) {
    setItems((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setItems((rows) => [...rows, emptyRow()]);
  }
  function removeRow(index: number) {
    setItems((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== index) : rows));
  }

  function lineTaxable(row: ItemRow): number {
    return (Number(row.quantity) || 0) * (Number(row.unitPrice) || 0);
  }
  function lineTax(row: ItemRow): number {
    return isGstApplicable ? (lineTaxable(row) * (Number(row.taxRatePercent) || 0)) / 100 : 0;
  }

  const subtotal = items.reduce((s, r) => s + lineTaxable(r), 0);
  const totalTax = items.reduce((s, r) => s + lineTax(r), 0);
  const transport = Number(transportAmount) || 0;
  const beforeRounding = subtotal + transport + totalTax;
  const total = Math.round(beforeRounding);
  const roundOff = total - beforeRounding;

  async function handleAttach(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAttaching(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await uploadExpenseAttachmentAction(formData);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setFileId(result.fileId);
      setFileName(file.name);
    } finally {
      setAttaching(false);
    }
  }

  async function submit() {
    if (!categoryAccountId) return toast.error("Select a category.");
    if (!payeeName.trim()) return toast.error("Enter a payee.");
    if (!paymentAccountId) return toast.error("Select where this was paid from.");
    const validItems = items.filter((r) => r.description.trim() && Number(r.quantity) > 0);
    if (validItems.length === 0) return toast.error("Add at least one line item.");

    start(async () => {
      const result = await createExpenseAction({
        expenseDate,
        categoryAccountId,
        payeeName,
        description: description || undefined,
        items: validItems.map((r) => ({
          description: r.description,
          quantity: Number(r.quantity),
          unitPrice: Number(r.unitPrice) || 0,
          taxRatePercent: isGstApplicable ? Number(r.taxRatePercent) || 0 : undefined,
        })),
        isGstApplicable,
        claimInputCredit,
        transportAmount: transport,
        method,
        paymentAccountId,
        fileId,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Expense submitted for approval.");
        router.push(`/expenses/${result.expenseId}`);
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Expense details</CardTitle>
          <label className="flex items-center gap-2 text-sm font-normal">
            <Checkbox
              checked={isGstApplicable}
              onCheckedChange={(v) => {
                const on = Boolean(v);
                setIsGstApplicable(on);
                if (!on) setClaimInputCredit(false);
              }}
            />
            GST
          </label>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="expenseDate">Date</Label>
            <Input id="expenseDate" type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={categoryAccountId} onValueChange={(v) => setCategoryAccountId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="payeeName">Payee</Label>
            <Input id="payeeName" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="Who was paid" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="hidden sm:grid grid-cols-12 gap-2 text-xs text-muted-foreground px-1">
            <div className="col-span-5">Item</div>
            <div className="col-span-2">Qty</div>
            <div className="col-span-2">Price/Unit</div>
            {isGstApplicable && <div className="col-span-1">Tax %</div>}
            <div className={isGstApplicable ? "col-span-2" : "col-span-3"}>Amount</div>
          </div>
          {items.map((row, index) => (
            <div key={index} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-11 sm:col-span-5">
                <Input
                  value={row.description}
                  placeholder="Item / description"
                  onChange={(e) => setRow(index, { description: e.target.value })}
                />
              </div>
              <div className="col-span-3 sm:col-span-2">
                <Input
                  type="number" min="0" step="0.01"
                  value={row.quantity}
                  onChange={(e) => setRow(index, { quantity: e.target.value })}
                />
              </div>
              <div className="col-span-4 sm:col-span-2">
                <Input
                  type="number" min="0" step="0.01"
                  value={row.unitPrice}
                  onChange={(e) => setRow(index, { unitPrice: e.target.value })}
                />
              </div>
              {isGstApplicable && (
                <div className="col-span-3 sm:col-span-1">
                  <Select value={row.taxRatePercent} onValueChange={(v) => setRow(index, { taxRatePercent: v ?? "0" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TAX_RATES.map((r) => <SelectItem key={r} value={r}>{r}%</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className={`flex items-center justify-between gap-1 ${isGstApplicable ? "col-span-4 sm:col-span-2" : "col-span-5 sm:col-span-3"}`}>
                <span className="text-sm tabular-nums">{inr(lineTaxable(row) + lineTax(row))}</span>
                <Button
                  type="button" variant="ghost" size="icon"
                  onClick={() => removeRow(index)}
                  disabled={items.length === 1}
                  aria-label="Remove line"
                >
                  <TrashIcon className="size-4" />
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            <PlusIcon className="size-4" /> Add Row
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Payment Type</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as (typeof METHODS)[number])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Paid From</Label>
              <Select value={paymentAccountId} onValueChange={(v) => setPaymentAccountId(v ?? "")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {paymentAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Attachment</Label>
              <div>
                <input
                  id="attachment" type="file" className="hidden"
                  accept="image/jpeg,image/png,application/pdf"
                  onChange={handleAttach}
                />
                <label
                  htmlFor="attachment"
                  aria-disabled={attaching}
                  className={buttonVariants({
                    variant: "outline",
                    size: "sm",
                    className: attaching ? "pointer-events-none opacity-50" : "cursor-pointer",
                  })}
                >
                  {attaching ? "Uploading…" : fileName ? "Replace attachment" : "Add image / document"}
                </label>
                {fileName && <p className="mt-1 text-xs text-muted-foreground">{fileName}</p>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="tabular-nums">{inr(subtotal)}</span>
            </div>
            {isGstApplicable && (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tax</span>
                  <span className="tabular-nums">{inr(totalTax)}</span>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={claimInputCredit} onCheckedChange={(v) => setClaimInputCredit(Boolean(v))} />
                  Claim as Input Tax Credit
                </label>
              </>
            )}
            <div className="space-y-2">
              <Label htmlFor="transportAmount">Transportation</Label>
              <Input
                id="transportAmount" type="number" min="0" step="0.01"
                value={transportAmount}
                onChange={(e) => setTransportAmount(e.target.value)}
              />
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Round off</span>
              <span className="tabular-nums">{inr(roundOff)}</span>
            </div>
            <div className="flex justify-between border-t pt-2 font-medium">
              <span>Total</span>
              <span className="tabular-nums">{inr(total)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Submitting…" : "Submit for Approval"}
        </Button>
      </div>
    </div>
  );
}
