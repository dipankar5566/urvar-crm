"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PlusIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createManualJournalEntryAction } from "../actions";

type AccountOption = { id: string; code: string; name: string; type: string };
type PartyOption = { id: string; name: string };

// The two control accounts party attribution applies to — matches
// AR_TRADE (1130) / AP_TRADE (2110) in chart-of-accounts.ts. Hardcoded by
// code here rather than an AccountKey lookup: this is a client component and
// cannot import account-map.ts (it pulls in the Prisma client).
const AR_CODE = "1130";
const AP_CODE = "2110";

type LineRow = {
  accountId: string;
  side: "debit" | "credit";
  amount: string;
  narration: string;
  partyId: string;
};
const emptyRow = (): LineRow => ({ accountId: "", side: "debit", amount: "", narration: "", partyId: "" });

const inr = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value);

export function ManualEntryForm({
  accounts,
  customers,
  suppliers,
}: {
  accounts: AccountOption[];
  customers: PartyOption[];
  suppliers: PartyOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<LineRow[]>([emptyRow(), emptyRow()]);
  // Minted once per form instance (not per render) — see actions.ts for why
  // this is the idempotency key's client half. Regenerated after a
  // successful post so a deliberate second identical entry is still allowed.
  const [clientToken, setClientToken] = useState(() => crypto.randomUUID());

  const accountsByCode = new Map(accounts.map((a) => [a.id, a]));

  function setRow(index: number, patch: Partial<LineRow>) {
    setLines((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setLines((rows) => [...rows, emptyRow()]);
  }
  function removeRow(index: number) {
    setLines((rows) => (rows.length > 2 ? rows.filter((_, i) => i !== index) : rows));
  }

  function partyOptionsFor(accountId: string): { type: "CUSTOMER" | "SUPPLIER"; options: PartyOption[] } | null {
    const account = accountsByCode.get(accountId);
    if (!account) return null;
    if (account.code === AR_CODE) return { type: "CUSTOMER", options: customers };
    if (account.code === AP_CODE) return { type: "SUPPLIER", options: suppliers };
    return null;
  }

  const totalDebit = lines.reduce((s, r) => s + (r.side === "debit" ? Number(r.amount) || 0 : 0), 0);
  const totalCredit = lines.reduce((s, r) => s + (r.side === "credit" ? Number(r.amount) || 0 : 0), 0);
  const difference = totalDebit - totalCredit;
  const balanced = lines.length >= 2 && lines.every((r) => r.accountId && Number(r.amount) > 0) && Math.abs(difference) < 0.005;

  async function submit() {
    if (!narration.trim()) return toast.error("Enter a narration.");
    if (!balanced) return toast.error("Debits must equal credits before this can be posted.");

    start(async () => {
      const result = await createManualJournalEntryAction({
        entryDate,
        narration,
        clientToken,
        lines: lines.map((r) => {
          const party = partyOptionsFor(r.accountId);
          return {
            accountId: r.accountId,
            debit: r.side === "debit" ? Number(r.amount) : undefined,
            credit: r.side === "credit" ? Number(r.amount) : undefined,
            narration: r.narration || undefined,
            partyType: party && r.partyId ? party.type : undefined,
            partyId: party && r.partyId ? r.partyId : undefined,
          };
        }),
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success(
          result.alreadyPosted ? "This entry was already posted." : "Journal entry posted.",
        );
        setClientToken(crypto.randomUUID());
        router.push("/accounting/journal");
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Entry details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="entryDate">Date</Label>
            <Input id="entryDate" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="narration">Narration</Label>
            <Textarea id="narration" value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="What is this entry for?" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {lines.map((row, index) => {
            const party = partyOptionsFor(row.accountId);
            return (
              <div key={index} className="grid grid-cols-12 gap-2 items-center border-b pb-3 last:border-0">
                <div className="col-span-12 sm:col-span-4">
                  <Select value={row.accountId} onValueChange={(v) => setRow(index, { accountId: v ?? "", partyId: "" })}>
                    <SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-4 sm:col-span-2">
                  <Select value={row.side} onValueChange={(v) => setRow(index, { side: v as "debit" | "credit" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="debit">Debit</SelectItem>
                      <SelectItem value="credit">Credit</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-8 sm:col-span-2">
                  <Input
                    type="number" min="0" step="0.01" placeholder="Amount"
                    value={row.amount}
                    onChange={(e) => setRow(index, { amount: e.target.value })}
                  />
                </div>
                <div className="col-span-12 sm:col-span-3">
                  <Input
                    placeholder="Line narration (optional)"
                    value={row.narration}
                    onChange={(e) => setRow(index, { narration: e.target.value })}
                  />
                </div>
                <div className="col-span-12 sm:col-span-1 flex justify-end">
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeRow(index)} disabled={lines.length === 2} aria-label="Remove line">
                    <TrashIcon className="size-4" />
                  </Button>
                </div>
                {party && (
                  <div className="col-span-12">
                    <Select value={row.partyId} onValueChange={(v) => setRow(index, { partyId: v ?? "" })}>
                      <SelectTrigger className="w-full sm:w-72">
                        <SelectValue placeholder={`${party.type === "CUSTOMER" ? "Customer" : "Supplier"} (optional, for party statements)`} />
                      </SelectTrigger>
                      <SelectContent>
                        {party.options.map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            );
          })}
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            <PlusIcon className="size-4" /> Add Line
          </Button>

          <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-3 text-sm">
            <div className="flex gap-6">
              <span>Total Debit: <span className="font-medium tabular-nums">{inr(totalDebit)}</span></span>
              <span>Total Credit: <span className="font-medium tabular-nums">{inr(totalCredit)}</span></span>
            </div>
            <span className={Math.abs(difference) < 0.005 ? "text-muted-foreground" : "font-medium text-destructive"}>
              {Math.abs(difference) < 0.005 ? "Balanced" : `Out of balance by ${inr(Math.abs(difference))}`}
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending || !balanced}>
          {pending ? "Posting…" : "Post Entry"}
        </Button>
      </div>
    </div>
  );
}
