"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { recordCashBankTransactionAction } from "../actions";

type AccountOption = { id: string; code: string; name: string };

const TYPE_LABELS = {
  DEPOSIT: "Cash → Bank deposit",
  WITHDRAWAL: "Bank → Cash withdrawal",
  TRANSFER: "Bank → Bank transfer",
  BANK_CHARGE: "Bank charge",
  INTEREST_INCOME: "Interest earned",
  CASH_ADJUSTMENT: "Cash count correction",
} as const;
type TxnType = keyof typeof TYPE_LABELS;

export function MovementForm({
  bankAccounts,
  expenseAccounts,
  incomeAccounts,
  defaultExpenseAccountId,
  defaultIncomeAccountId,
}: {
  bankAccounts: AccountOption[];
  expenseAccounts: AccountOption[];
  incomeAccounts: AccountOption[];
  defaultExpenseAccountId: string;
  defaultIncomeAccountId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [type, setType] = useState<TxnType>("DEPOSIT");
  const [txnDate, setTxnDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? "");
  const [fromAccountId, setFromAccountId] = useState(bankAccounts[0]?.id ?? "");
  const [toAccountId, setToAccountId] = useState(bankAccounts[1]?.id ?? bankAccounts[0]?.id ?? "");
  const [expenseAccountId, setExpenseAccountId] = useState(defaultExpenseAccountId);
  const [incomeAccountId, setIncomeAccountId] = useState(defaultIncomeAccountId);
  const [direction, setDirection] = useState<"SHORTAGE" | "OVERAGE">("SHORTAGE");

  function submit() {
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) return toast.error("Enter an amount greater than zero.");
    if ((type === "DEPOSIT" || type === "WITHDRAWAL" || type === "BANK_CHARGE" || type === "INTEREST_INCOME") && !bankAccountId) {
      return toast.error("Select a bank account.");
    }
    if (type === "TRANSFER" && (!fromAccountId || !toAccountId || fromAccountId === toAccountId)) {
      return toast.error("Select two different accounts to transfer between.");
    }

    const base = { txnDate, amount: amountNum, reference: reference || undefined, notes: notes || undefined };

    start(async () => {
      const result = await recordCashBankTransactionAction(
        type === "DEPOSIT" || type === "WITHDRAWAL"
          ? { type, bankAccountId, ...base }
          : type === "TRANSFER"
            ? { type, fromAccountId, toAccountId, ...base }
            : type === "BANK_CHARGE"
              ? { type, bankAccountId, expenseAccountId, ...base }
              : type === "INTEREST_INCOME"
                ? { type, bankAccountId, incomeAccountId, ...base }
                : { type, direction, adjustmentAccountId: expenseAccountId, ...base },
      );
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Recorded.");
        router.push("/accounting/cash-bank");
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Movement details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as TxnType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="txnDate">Date</Label>
            <Input id="txnDate" type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="amount">Amount</Label>
            <Input id="amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>

          {(type === "DEPOSIT" || type === "WITHDRAWAL" || type === "BANK_CHARGE" || type === "INTEREST_INCOME") && (
            <div className="space-y-2">
              <Label>Bank account</Label>
              <Select value={bankAccountId} onValueChange={(v) => setBankAccountId(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Select bank account" /></SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {type === "TRANSFER" && (
            <>
              <div className="space-y-2">
                <Label>From</Label>
                <Select value={fromAccountId} onValueChange={(v) => setFromAccountId(v ?? "")}>
                  <SelectTrigger><SelectValue placeholder="From account" /></SelectTrigger>
                  <SelectContent>
                    {bankAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>To</Label>
                <Select value={toAccountId} onValueChange={(v) => setToAccountId(v ?? "")}>
                  <SelectTrigger><SelectValue placeholder="To account" /></SelectTrigger>
                  <SelectContent>
                    {bankAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {type === "BANK_CHARGE" && (
            <div className="space-y-2">
              <Label>Expense category</Label>
              <Select value={expenseAccountId} onValueChange={(v) => setExpenseAccountId(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Select expense account" /></SelectTrigger>
                <SelectContent>
                  {expenseAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {type === "INTEREST_INCOME" && (
            <div className="space-y-2">
              <Label>Income category</Label>
              <Select value={incomeAccountId} onValueChange={(v) => setIncomeAccountId(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Select income account" /></SelectTrigger>
                <SelectContent>
                  {incomeAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {type === "CASH_ADJUSTMENT" && (
            <div className="space-y-2">
              <Label>Physical count found</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as "SHORTAGE" | "OVERAGE")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="SHORTAGE">Less cash than the books show (shortage)</SelectItem>
                  <SelectItem value="OVERAGE">More cash than the books show (overage)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Posts against Cash Short / (Over) — the standard account for physical-count differences.</p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="reference">Reference (optional)</Label>
            <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Cheque no., UTR, ..." />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Recording…" : "Record Movement"}
        </Button>
      </div>
    </div>
  );
}
