"use client";

import { useMemo, useState, useTransition } from "react";
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
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { createStockValuationAction } from "../actions";

type Period = { id: string; label: string; financialYear: number; endDate: Date };
type ProductOption = { id: string; sku: string; name: string; unit: string; suggestedUnitCost: string | null };

export function NewValuationForm({ periods, products }: { periods: Period[]; products: ProductOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [periodId, setPeriodId] = useState(periods[0]?.id ?? "");
  const selectedPeriod = useMemo(() => periods.find((p) => p.id === periodId), [periods, periodId]);
  const [valuationDate, setValuationDate] = useState(
    () => periods[0]?.endDate.toISOString().slice(0, 10) ?? "",
  );
  const [notes, setNotes] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [unitCostOverrides, setUnitCostOverrides] = useState<Record<string, string>>({});

  function onSelectPeriod(id: string) {
    setPeriodId(id);
    const period = periods.find((p) => p.id === id);
    if (period) setValuationDate(period.endDate.toISOString().slice(0, 10));
  }

  async function submit() {
    if (!periodId) return toast.error("Select a period.");
    if (!valuationDate) return toast.error("Set a valuation date.");

    const lines = products
      .filter((p) => (quantities[p.id] ?? "").trim() !== "")
      .map((p) => ({
        productId: p.id,
        quantityOnHand: quantities[p.id],
        unitCost: unitCostOverrides[p.id]?.trim() || undefined,
      }));

    if (lines.length === 0) return toast.error("Enter a quantity for at least one product.");

    start(async () => {
      const result = await createStockValuationAction({
        periodId,
        valuationDate,
        notes: notes || undefined,
        lines,
      });
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success("Valuation drafted. Review and post it when ready.");
        router.push(`/accounting/inventory/${result.valuationId}`);
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Valuation details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Period</Label>
            <Select value={periodId} onValueChange={(v) => v && onSelectPeriod(v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select period" />
              </SelectTrigger>
              <SelectContent>
                {periods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label} ({p.financialYear}-{(p.financialYear + 1) % 100})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="valuationDate">Valuation Date</Label>
            <Input
              id="valuationDate"
              type="date"
              value={valuationDate}
              onChange={(e) => setValuationDate(e.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-3">
            <Label htmlFor="notes">Source of quantities (recommended)</Label>
            <Textarea
              id="notes"
              placeholder="e.g. Physical count on 30 Sep 2026, or ERP stock report as of that date"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Product quantities</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Quantity On Hand</TableHead>
                <TableHead>Unit Cost (₹)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">{p.sku}</div>
                  </TableCell>
                  <TableCell>{p.unit}</TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      className="w-32"
                      value={quantities[p.id] ?? ""}
                      onChange={(e) => setQuantities((q) => ({ ...q, [p.id]: e.target.value }))}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min="0"
                      step="0.0001"
                      className="w-32"
                      placeholder={p.suggestedUnitCost ?? "no purchase history"}
                      value={unitCostOverrides[p.id] ?? ""}
                      onChange={(e) => setUnitCostOverrides((c) => ({ ...c, [p.id]: e.target.value }))}
                    />
                    {!p.suggestedUnitCost && (
                      <p className="mt-1 text-xs text-amber-600">
                        No purchase history — a manual cost is required for this line.
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        The placeholder cost shown is a weighted average as of the most recently opened period&apos;s
        end date, for reference only. The actual cost used is recomputed as of the valuation date you
        set above when you save. Leave the cost field blank to use that computed average, or type a
        value to override it.
      </p>

      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={() => router.push("/accounting/inventory")}>
          Cancel
        </Button>
        <Button disabled={pending || !selectedPeriod} onClick={submit}>
          {pending ? "Saving…" : "Save Draft"}
        </Button>
      </div>
    </div>
  );
}
