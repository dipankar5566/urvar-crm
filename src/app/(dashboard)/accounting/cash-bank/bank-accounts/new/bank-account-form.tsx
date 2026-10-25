"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createBankAccountAction } from "../actions";

type LedgerOption = { id: string; code: string; name: string };

const NEW_LEDGER = "__new__";

export function BankAccountForm({ unlinkedLedgers }: { unlinkedLedgers: LedgerOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [ledgerChoice, setLedgerChoice] = useState(NEW_LEDGER);
  const [displayName, setDisplayName] = useState("");
  const [bankName, setBankName] = useState("");
  const [branch, setBranch] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [accountHolderName, setAccountHolderName] = useState("");
  const [upiId, setUpiId] = useState("");
  const [isOverdraft, setIsOverdraft] = useState(false);
  const [printOnInvoice, setPrintOnInvoice] = useState(false);
  const [openingBalance, setOpeningBalance] = useState("");
  const [openingDate, setOpeningDate] = useState(() => new Date().toISOString().slice(0, 10));

  const attaching = ledgerChoice !== NEW_LEDGER;

  function submit() {
    if (!displayName.trim()) return toast.error("Enter a display name.");
    const opening = openingBalance ? Number(openingBalance) : 0;
    if (Number.isNaN(opening)) return toast.error("Opening balance must be a number.");

    start(async () => {
      const result = await createBankAccountAction({
        displayName,
        bankName: bankName || undefined,
        branch: branch || undefined,
        accountNumber: accountNumber || undefined,
        ifsc: ifsc || undefined,
        accountHolderName: accountHolderName || undefined,
        upiId: upiId || undefined,
        isOverdraft,
        printOnInvoice,
        openingBalance: attaching ? undefined : opening,
        openingDate: attaching || !opening ? undefined : openingDate,
        existingLedgerAccountId: attaching ? ledgerChoice : undefined,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Bank account saved.");
        router.push("/accounting/cash-bank/bank-accounts");
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {unlinkedLedgers.length > 0 && (
            <div className="space-y-2 sm:col-span-2">
              <Label>Ledger</Label>
              <Select value={ledgerChoice} onValueChange={(v) => setLedgerChoice(v ?? NEW_LEDGER)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NEW_LEDGER}>Create a new bank ledger under 1120</SelectItem>
                  {unlinkedLedgers.map((l) => (
                    <SelectItem key={l.id} value={l.id}>Attach to existing: {l.code} {l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {attaching && (
                <p className="text-xs text-muted-foreground">
                  This ledger already carries its balance from real postings, so no opening balance is posted.
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="displayName">Display name</Label>
            <Input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="HDFC Current" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="accountHolderName">Account holder (optional)</Label>
            <Input id="accountHolderName" value={accountHolderName} onChange={(e) => setAccountHolderName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="accountNumber">Account number (optional)</Label>
            <Input id="accountNumber" inputMode="numeric" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ifsc">IFSC (optional)</Label>
            <Input id="ifsc" value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} placeholder="HDFC0001234" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bankName">Bank name (optional)</Label>
            <Input id="bankName" value={bankName} onChange={(e) => setBankName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch">Branch (optional)</Label>
            <Input id="branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="upiId">UPI ID (optional)</Label>
            <Input id="upiId" value={upiId} onChange={(e) => setUpiId(e.target.value)} placeholder="business@hdfcbank" />
          </div>

          <div className="flex flex-col justify-end gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={isOverdraft} onChange={(e) => setIsOverdraft(e.target.checked)} />
              Overdraft / cash-credit account
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={printOnInvoice} onChange={(e) => setPrintOnInvoice(e.target.checked)} />
              Print on invoices
            </label>
          </div>

          {!attaching && (
            <>
              <div className="space-y-2">
                <Label htmlFor="openingBalance">Opening balance (optional)</Label>
                <Input
                  id="openingBalance"
                  type="number"
                  step="0.01"
                  value={openingBalance}
                  onChange={(e) => setOpeningBalance(e.target.value)}
                  placeholder={isOverdraft ? "Negative if overdrawn" : "0.00"}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="openingDate">As of</Label>
                <Input id="openingDate" type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Saving…" : "Save Bank Account"}
        </Button>
      </div>
    </div>
  );
}
