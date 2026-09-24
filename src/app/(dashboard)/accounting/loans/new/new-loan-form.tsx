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
import { createLoanAction, suggestEmiAction } from "../actions";

type AccountOption = { id: string; code: string; name: string };

export function NewLoanForm({ cashAndBankAccounts }: { cashAndBankAccounts: AccountOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [suggesting, setSuggesting] = useState(false);

  const [lenderName, setLenderName] = useState("");
  const [lenderReference, setLenderReference] = useState("");
  const [disbursedToAccountId, setDisbursedToAccountId] = useState(cashAndBankAccounts[0]?.id ?? "");
  const [principal, setPrincipal] = useState("");
  const [annualRatePercent, setAnnualRatePercent] = useState("");
  const [tenureMonths, setTenureMonths] = useState("");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [emiAmount, setEmiAmount] = useState("");
  const [notes, setNotes] = useState("");

  async function suggest() {
    if (!principal || !annualRatePercent || !tenureMonths) {
      return toast.error("Enter principal, rate and tenure first.");
    }
    setSuggesting(true);
    try {
      const result = await suggestEmiAction({
        principal: Number(principal),
        annualRatePercent: Number(annualRatePercent),
        tenureMonths: Number(tenureMonths),
      });
      if ("error" in result) toast.error(result.error);
      else setEmiAmount(result.emi);
    } finally {
      setSuggesting(false);
    }
  }

  function submit() {
    if (!lenderName.trim()) return toast.error("Enter the lender's name.");
    if (!disbursedToAccountId) return toast.error("Select where the loan was disbursed to.");
    if (!principal || Number(principal) <= 0) return toast.error("Enter the principal amount.");
    if (!tenureMonths || Number(tenureMonths) <= 0) return toast.error("Enter the tenure in months.");
    if (!emiAmount || Number(emiAmount) <= 0) return toast.error("Enter the instalment (EMI) amount.");

    start(async () => {
      const result = await createLoanAction({
        lenderName,
        lenderReference: lenderReference || undefined,
        disbursedToAccountId,
        principal: Number(principal),
        annualRatePercent: Number(annualRatePercent) || 0,
        tenureMonths: Number(tenureMonths),
        startDate,
        emiAmount: Number(emiAmount),
        notes: notes || undefined,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Loan recorded and disbursement posted.");
        router.push(`/accounting/loans/${result.loanId}`);
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Loan details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="lenderName">Lender</Label>
            <Input id="lenderName" value={lenderName} onChange={(e) => setLenderName(e.target.value)} placeholder="e.g. HDFC Bank" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lenderReference">Lender&apos;s reference (optional)</Label>
            <Input id="lenderReference" value={lenderReference} onChange={(e) => setLenderReference(e.target.value)} placeholder="Loan account no." />
          </div>
          <div className="space-y-2">
            <Label>Disbursed to</Label>
            <Select value={disbursedToAccountId} onValueChange={(v) => setDisbursedToAccountId(v ?? "")}>
              <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
              <SelectContent>
                {cashAndBankAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="startDate">Disbursement date</Label>
            <Input id="startDate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="principal">Principal</Label>
            <Input id="principal" type="number" min="0" step="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="annualRatePercent">Annual interest rate (%)</Label>
            <Input id="annualRatePercent" type="number" min="0" step="0.001" value={annualRatePercent} onChange={(e) => setAnnualRatePercent(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tenureMonths">Tenure (months)</Label>
            <Input id="tenureMonths" type="number" min="1" step="1" value={tenureMonths} onChange={(e) => setTenureMonths(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="emiAmount">Instalment (EMI) — as quoted by the lender</Label>
            <div className="flex gap-2">
              <Input id="emiAmount" type="number" min="0" step="0.01" value={emiAmount} onChange={(e) => setEmiAmount(e.target.value)} />
              <Button type="button" variant="outline" onClick={suggest} disabled={suggesting}>
                {suggesting ? "…" : "Suggest"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Enter the EMI from the lender&apos;s sanction letter. &quot;Suggest&quot; is only a textbook estimate.
            </p>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Recording…" : "Record Loan"}
        </Button>
      </div>
    </div>
  );
}
