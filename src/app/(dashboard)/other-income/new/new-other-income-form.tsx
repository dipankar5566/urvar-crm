"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { createOtherIncomeAction } from "../actions";

type AccountOption = { id: string; code: string; name: string };
const METHODS = ["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"] as const;
const TAX_RATES = ["0", "5", "12", "18", "28"];

const inr = (value: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value);

/**
 * Flat-amount entry only — unlike NewExpenseForm, there's no itemised-lines
 * UI here. createOtherIncome() already supports an `items` array (needed for
 * per-line GST on the GSTR reports), but Other Income entries are rare and
 * usually a single round figure, so that path is reachable only via the
 * server action/tests for now, not this form.
 */
export function NewOtherIncomeForm({
  categories,
  depositAccounts,
}: {
  categories: AccountOption[];
  depositAccounts: AccountOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [incomeDate, setIncomeDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [categoryAccountId, setCategoryAccountId] = useState("");
  const [payerName, setPayerName] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [isGstApplicable, setIsGstApplicable] = useState(false);
  const [taxRatePercent, setTaxRatePercent] = useState("0");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("CASH");
  const [depositAccountId, setDepositAccountId] = useState(depositAccounts[0]?.id ?? "");

  const amountNum = Number(amount) || 0;
  const taxable = isGstApplicable ? amountNum / (1 + Number(taxRatePercent) / 100) : amountNum;
  const tax = amountNum - taxable;

  function submit() {
    if (!categoryAccountId) return toast.error("Select a category.");
    if (!payerName.trim()) return toast.error("Enter who paid this.");
    if (amountNum <= 0) return toast.error("Enter an amount greater than 0.");
    if (!depositAccountId) return toast.error("Select where this was received into.");

    start(async () => {
      const result = await createOtherIncomeAction({
        incomeDate,
        categoryAccountId,
        payerName,
        description: description || undefined,
        items: [
          {
            description: description || payerName,
            quantity: 1,
            unitPrice: taxable,
            taxRatePercent: isGstApplicable ? Number(taxRatePercent) : undefined,
          },
        ],
        isGstApplicable,
        method,
        depositAccountId,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Income recorded.");
        router.push(`/other-income/${result.otherIncomeId}`);
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Income details</CardTitle>
          <label className="flex items-center gap-2 text-sm font-normal">
            <Checkbox checked={isGstApplicable} onCheckedChange={(v) => setIsGstApplicable(Boolean(v))} />
            GST
          </label>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="incomeDate">Date</Label>
            <Input id="incomeDate" type="date" value={incomeDate} onChange={(e) => setIncomeDate(e.target.value)} />
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
            <Label htmlFor="payerName">Payer</Label>
            <Input id="payerName" value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="Who paid this" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="amount">Amount</Label>
            <Input id="amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {isGstApplicable && (
            <div className="space-y-2">
              <Label>Tax %</Label>
              <Select value={taxRatePercent} onValueChange={(v) => setTaxRatePercent(v ?? "0")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TAX_RATES.map((r) => <SelectItem key={r} value={r}>{r}%</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Received into</CardTitle>
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
              <Label>Deposited To</Label>
              <Select value={depositAccountId} onValueChange={(v) => setDepositAccountId(v ?? "")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {depositAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Taxable value</span>
              <span className="tabular-nums">{inr(taxable)}</span>
            </div>
            {isGstApplicable && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Tax</span>
                <span className="tabular-nums">{inr(tax)}</span>
              </div>
            )}
            <div className="flex justify-between border-t pt-2 font-medium">
              <span>Total</span>
              <span className="tabular-nums">{inr(amountNum)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Saving…" : "Record Income"}
        </Button>
      </div>
    </div>
  );
}
