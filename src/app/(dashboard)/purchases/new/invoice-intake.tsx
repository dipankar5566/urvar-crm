"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { SaveIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createPurchaseInvoice,
  extractInvoiceAction,
  type ExtractedInvoice,
  type ExtractedLine,
} from "../actions";

const inr = (value: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value);

/**
 * Upload an invoice, check what was read, save.
 *
 * Every extracted value is editable. Reading rates and quantities off a scan
 * gets things wrong, and unlike a misread address a wrong cost figure quietly
 * corrupts what the business thinks it paid — so nothing here is
 * write-through.
 */
export function InvoiceIntake() {
  const router = useRouter();
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, startSaving] = useTransition();
  const [invoice, setInvoice] = useState<ExtractedInvoice | null>(null);

  async function upload(file: File) {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await extractInvoiceAction(formData);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setInvoice(result.invoice);
      if (result.invoice.lines.length === 0) {
        toast.warning("No line items were found. Add them by hand before saving.");
      }
    } catch {
      toast.error("Could not read that invoice. Please try again.");
    } finally {
      setIsUploading(false);
    }
  }

  function setField<K extends keyof ExtractedInvoice>(key: K, value: ExtractedInvoice[K]) {
    setInvoice((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function setLine(index: number, patch: Partial<ExtractedLine>) {
    setInvoice((prev) => {
      if (!prev) return prev;
      const lines = prev.lines.map((line, i) => (i === index ? { ...line, ...patch } : line));
      return { ...prev, lines };
    });
  }

  function removeLine(index: number) {
    setInvoice((prev) =>
      prev ? { ...prev, lines: prev.lines.filter((_, i) => i !== index) } : prev,
    );
  }

  function save() {
    if (!invoice) return;
    startSaving(async () => {
      const result = await createPurchaseInvoice({
        supplierName: invoice.supplierName,
        supplierGst: invoice.supplierGst,
        supplierPhone: invoice.supplierPhone,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        subtotal: invoice.subtotal,
        taxAmount: invoice.taxAmount,
        totalAmount: invoice.totalAmount,
        lines: invoice.lines,
        fileId: invoice.fileId,
      });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Invoice recorded.");
      router.push("/purchases");
      router.refresh();
    });
  }

  const linesTotal = (invoice?.lines ?? []).reduce((sum, line) => sum + line.lineTotal, 0);
  // Worth surfacing rather than silently trusting either number: if the line
  // totals don't add up to the invoice total, something was misread.
  const totalsDisagree =
    invoice !== null && invoice.lines.length > 0 && Math.abs(linesTotal - invoice.totalAmount) > 1;

  if (!invoice) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload the invoice</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            disabled={isUploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
              e.target.value = "";
            }}
          />
          <p className="text-xs text-muted-foreground">
            {isUploading
              ? "Reading the invoice — this takes a few seconds…"
              : "PDF, JPG or PNG, up to 10 pages."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoice details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="supplierName">Supplier *</Label>
            <Input
              id="supplierName"
              value={invoice.supplierName}
              placeholder="Not found"
              onChange={(e) => setField("supplierName", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invoiceNumber">Invoice number *</Label>
            <Input
              id="invoiceNumber"
              value={invoice.invoiceNumber}
              placeholder="Not found"
              onChange={(e) => setField("invoiceNumber", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invoiceDate">Invoice date *</Label>
            <Input
              id="invoiceDate"
              type="date"
              value={invoice.invoiceDate}
              onChange={(e) => setField("invoiceDate", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="supplierGst">Supplier GST</Label>
            <Input
              id="supplierGst"
              value={invoice.supplierGst}
              placeholder="Not found"
              onChange={(e) => setField("supplierGst", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="subtotal">Subtotal</Label>
            <Input
              id="subtotal"
              type="number"
              step="0.01"
              value={invoice.subtotal}
              onChange={(e) => setField("subtotal", Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="taxAmount">Tax</Label>
            <Input
              id="taxAmount"
              type="number"
              step="0.01"
              value={invoice.taxAmount}
              onChange={(e) => setField("taxAmount", Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="totalAmount">Total *</Label>
            <Input
              id="totalAmount"
              type="number"
              step="0.01"
              value={invoice.totalAmount}
              onChange={(e) => setField("totalAmount", Number(e.target.value))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items ({invoice.lines.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {totalsDisagree && (
            <p className="text-sm text-destructive">
              Line items add up to {inr(linesTotal)}, but the invoice total says{" "}
              {inr(invoice.totalAmount)}. Check both before saving.
            </p>
          )}
          {invoice.lines.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No line items were read from this invoice.
            </p>
          )}
          {invoice.lines.map((line, index) => (
            <div key={index} className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-5 space-y-1.5">
                <Label className="text-xs">Description</Label>
                <Input
                  value={line.description}
                  onChange={(e) => setLine(index, { description: e.target.value })}
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs">Qty</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={line.quantity}
                  onChange={(e) => setLine(index, { quantity: Number(e.target.value) })}
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs">Rate</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={line.unitPrice}
                  onChange={(e) => setLine(index, { unitPrice: Number(e.target.value) })}
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs">Line total</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={line.lineTotal}
                  onChange={(e) => setLine(index, { lineTotal: Number(e.target.value) })}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="col-span-1"
                aria-label={`Remove line ${index + 1}`}
                onClick={() => removeLine(index)}
              >
                <TrashIcon />
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Lines are recorded as written on the invoice. Matching them to catalogue products
            isn&apos;t required — a supplier lists what they sell, not what we do.
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={() => setInvoice(null)}>
          Start over
        </Button>
        <Button size="sm" disabled={isSaving} onClick={save}>
          <SaveIcon /> Save invoice
        </Button>
      </div>
    </div>
  );
}
