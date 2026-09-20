"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { createExpenseAction } from "../actions";

type AccountOption = { id: string; code: string; name: string };
const METHODS = ["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"] as const;

export function NewExpenseForm({
  categories,
  paymentAccounts,
}: {
  categories: AccountOption[];
  paymentAccounts: AccountOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [categoryAccountId, setCategoryAccountId] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("CASH");
  const [paymentAccountId, setPaymentAccountId] = useState(paymentAccounts[0]?.id ?? "");

  async function submit() {
    if (!categoryAccountId) return toast.error("Select a category.");
    if (!payeeName.trim()) return toast.error("Enter a payee.");
    if (!amount || Number(amount) <= 0) return toast.error("Enter a valid amount.");
    if (!paymentAccountId) return toast.error("Select where this was paid from.");

    start(async () => {
      const result = await createExpenseAction({
        expenseDate, categoryAccountId, payeeName, description: description || undefined,
        amount: Number(amount), method, paymentAccountId,
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Expense details</CardTitle>
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
        <div className="space-y-2">
          <Label htmlFor="amount">Amount (₹)</Label>
          <Input id="amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
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
          <Label htmlFor="description">Description (optional)</Label>
          <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="sm:col-span-2 flex justify-end">
          <Button onClick={submit} disabled={pending}>
            {pending ? "Submitting…" : "Submit for Approval"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
