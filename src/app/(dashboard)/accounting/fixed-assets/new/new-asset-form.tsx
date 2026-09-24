"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createFixedAssetAction } from "../actions";

type AccountOption = { id: string; code: string; name: string };
type InvoiceOption = { id: string; label: string; subtotal: string };

export function NewAssetForm({
  assetCategories,
  cashAndBankAccounts,
  eligibleInvoices,
}: {
  assetCategories: AccountOption[];
  cashAndBankAccounts: AccountOption[];
  eligibleInvoices: InvoiceOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [name, setName] = useState("");
  const [assetAccountId, setAssetAccountId] = useState(assetCategories[0]?.id ?? "");
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fundedBy, setFundedBy] = useState<"cash" | "invoice">("cash");
  const [paidFromAccountId, setPaidFromAccountId] = useState(cashAndBankAccounts[0]?.id ?? "");
  const [sourcePurchaseInvoiceId, setSourcePurchaseInvoiceId] = useState(eligibleInvoices[0]?.id ?? "");
  const [cost, setCost] = useState("");
  const [depreciationRatePercent, setDepreciationRatePercent] = useState("");
  const [salvageValue, setSalvageValue] = useState("0");

  function submit() {
    if (!name.trim()) return toast.error("Enter the asset's name.");
    if (!assetAccountId) return toast.error("Select an asset category.");
    if (!cost || Number(cost) <= 0) return toast.error("Enter the cost.");
    if (fundedBy === "cash" && !paidFromAccountId) return toast.error("Select which account this was paid from.");
    if (fundedBy === "invoice" && !sourcePurchaseInvoiceId) return toast.error("Select the source purchase invoice.");

    start(async () => {
      const result = await createFixedAssetAction({
        name,
        assetAccountId,
        purchaseDate,
        cost: Number(cost),
        depreciationRatePercent: Number(depreciationRatePercent) || 0,
        salvageValue: Number(salvageValue) || 0,
        paidFromAccountId: fundedBy === "cash" ? paidFromAccountId : undefined,
        sourcePurchaseInvoiceId: fundedBy === "invoice" ? sourcePurchaseInvoiceId : undefined,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Asset recorded and capitalised.");
        router.push(`/accounting/fixed-assets/${result.fixedAssetId}`);
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Asset details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tata Ace delivery van" />
          </div>
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={assetAccountId} onValueChange={(v) => setAssetAccountId(v ?? "")}>
              <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
              <SelectContent>
                {assetCategories.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="purchaseDate">Purchase date</Label>
            <Input id="purchaseDate" type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cost">Cost</Label>
            <Input id="cost" type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="depreciationRatePercent">Annual WDV depreciation rate (%)</Label>
            <Input id="depreciationRatePercent" type="number" min="0" max="100" step="0.001" value={depreciationRatePercent} onChange={(e) => setDepreciationRatePercent(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="salvageValue">Salvage value</Label>
            <Input id="salvageValue" type="number" min="0" step="0.01" value={salvageValue} onChange={(e) => setSalvageValue(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Funding</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Select value={fundedBy} onValueChange={(v) => setFundedBy(v as "cash" | "invoice")}>
            <SelectTrigger className="w-full sm:w-80"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="cash">Paid from cash / bank</SelectItem>
              <SelectItem value="invoice">On credit — capitalise an existing purchase invoice</SelectItem>
            </SelectContent>
          </Select>

          {fundedBy === "cash" && (
            <div className="space-y-2">
              <Label>Paid from</Label>
              <Select value={paidFromAccountId} onValueChange={(v) => setPaidFromAccountId(v ?? "")}>
                <SelectTrigger className="w-full sm:w-80"><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {cashAndBankAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {fundedBy === "invoice" && (
            <div className="space-y-2">
              <Label>Source purchase invoice</Label>
              <Select value={sourcePurchaseInvoiceId} onValueChange={(v) => setSourcePurchaseInvoiceId(v ?? "")}>
                <SelectTrigger className="w-full sm:w-96"><SelectValue placeholder="Select invoice" /></SelectTrigger>
                <SelectContent>
                  {eligibleInvoices.map((inv) => (
                    <SelectItem key={inv.id} value={inv.id}>{inv.label} (₹{inv.subtotal})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Capitalised cost cannot exceed the invoice&apos;s subtotal. This reclassifies the spend off Purchases
                onto the balance sheet — it does not create a new payable, since the invoice already did.
              </p>
              {eligibleInvoices.length === 0 && (
                <p className="text-xs text-destructive">No posted purchase invoices are available to capitalise.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Recording…" : "Record Asset"}
        </Button>
      </div>
    </div>
  );
}
