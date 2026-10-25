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

// Labels follow Vyapar's Cash & Bank menu (docs/VYAPAR_PARITY_SPEC.md §1, G2-G4).
const TYPE_LABELS = {
  DEPOSIT: "Cash → Bank (deposit)",
  WITHDRAWAL: "Bank → Cash (withdrawal)",
  TRANSFER: "Bank → Bank transfer",
  BANK_ADJ_INCREASE: "Increase bank balance (no cash side)",
  BANK_ADJ_DECREASE: "Decrease bank balance (no cash side)",
  BANK_CHARGE: "Bank charge",
  INTEREST_INCOME: "Interest earned",
  CASH_ADJUSTMENT: "Add / reduce cash",
} as const;
type TxnType = keyof typeof TYPE_LABELS;

const NEEDS_BANK: ReadonlySet<TxnType> = new Set([
  "DEPOSIT",
  "WITHDRAWAL",
  "BANK_CHARGE",
  "INTEREST_INCOME",
  "BANK_ADJ_INCREASE",
  "BANK_ADJ_DECREASE",
]);

/** Sentinel for "Capital Adjustments (default)" — sent to the server as no account. */
const DEFAULT_OFFSET = "__default__";

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
  const [direction, setDirection] = useState<"SHORTAGE" | "OVERAGE">("OVERAGE");
  const [offsetAccountId, setOffsetAccountId] = useState(DEFAULT_OFFSET);

  function submit() {
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) return toast.error("Enter an amount greater than zero.");
    if (NEEDS_BANK.has(type) && !bankAccountId) return toast.error("Select a bank account.");
    if (type === "TRANSFER" && (!fromAccountId || !toAccountId || fromAccountId === toAccountId)) {
      return toast.error("Select two different accounts to transfer between.");
    }

    const base = { txnDate, amount: amountNum, reference: reference || undefined, notes: notes || undefined };

    start(async () => {
      const result = await recordCashBankTransactionAction(
        type === "DEPOSIT" || type === "WITHDRAWAL" || type === "BANK_ADJ_INCREASE" || type === "BANK_ADJ_DECREASE"
          ? { type, bankAccountId, ...base }
          : type === "TRANSFER"
            ? { type, fromAccountId, toAccountId, ...base }
            : type === "BANK_CHARGE"
              ? { type, bankAccountId, expenseAccountId, ...base }
              : type === "INTEREST_INCOME"
                ? { type, bankAccountId, incomeAccountId, ...base }
                : {
                    type,
                    direction,
                    adjustmentAccountId: offsetAccountId === DEFAULT_OFFSET ? undefined : offsetAccountId,
                    ...base,
                  },
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

          {NEEDS_BANK.has(type) && (
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
              {(type === "BANK_ADJ_INCREASE" || type === "BANK_ADJ_DECREASE") && (
                <p className="text-xs text-muted-foreground">
                  Posts against Capital Adjustments → Bank Adjustment (3420). Use Bank charge or Interest earned when
                  the bank statement says why the balance changed.
                </p>
              )}
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
            <>
              <div className="space-y-2">
                <Label>Adjustment</Label>
                <Select value={direction} onValueChange={(v) => setDirection(v as "SHORTAGE" | "OVERAGE")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OVERAGE">Add cash</SelectItem>
                    <SelectItem value="SHORTAGE">Reduce cash</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Offset account</Label>
                <Select value={offsetAccountId} onValueChange={(v) => setOffsetAccountId(v ?? DEFAULT_OFFSET)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_OFFSET}>3410 Capital Adjustments → Cash Adjustment (default)</SelectItem>
                    {expenseAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Pick 5800 Cash Short / (Over) for a physical-count difference that should hit profit.
                </p>
              </div>
            </>
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
