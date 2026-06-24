"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { inr } from "@/lib/constants/labels";
import { createQuotation, updateQuotation } from "./actions";
import type { QuotationFormInput } from "@/lib/validations/quotation";

type Option = { id: string; label: string };
type ProductOption = {
  id: string;
  name: string;
  sku: string;
  unit: string;
  mrp: string;
  dealerPrice: string | null;
  distributorPrice: string | null;
  gstPercent: string;
};

type ItemRow = {
  productId: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
};

const EMPTY_ITEM: ItemRow = { productId: "", quantity: "1", unitPrice: "", discountPercent: "0" };

export type QuotationFormValues = {
  customerId: string;
  leadId: string;
  validUntil: string;
  discountPercent: string;
  freightAmount: string;
  termsAndConditions: string;
  notes: string;
  items: ItemRow[];
};

export function QuotationForm({
  quotationId,
  initialValues,
  customers,
  leads,
  products,
}: {
  quotationId?: string;
  initialValues?: QuotationFormValues;
  customers: Option[];
  leads: Option[];
  products: ProductOption[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [target, setTarget] = useState<"customer" | "lead">(
    initialValues?.leadId ? "lead" : "customer",
  );
  const [values, setValues] = useState<QuotationFormValues>(
    initialValues ?? {
      customerId: "",
      leadId: "",
      validUntil: "",
      discountPercent: "0",
      freightAmount: "0",
      termsAndConditions: "",
      notes: "",
      items: [{ ...EMPTY_ITEM }],
    },
  );

  const set = <K extends keyof QuotationFormValues>(key: K) => (value: QuotationFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  function addItem() {
    setValues((prev) => ({ ...prev, items: [...prev.items, { ...EMPTY_ITEM }] }));
  }

  function removeItem(index: number) {
    setValues((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== index) }));
  }

  function updateItem(index: number, patch: Partial<ItemRow>) {
    setValues((prev) => ({
      ...prev,
      items: prev.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    }));
  }

  function onSelectProduct(index: number, productId: string) {
    const product = productMap.get(productId);
    const defaultPrice = product?.dealerPrice ?? product?.distributorPrice ?? product?.mrp ?? "0";
    updateItem(index, { productId, unitPrice: defaultPrice });
  }

  const totals = useMemo(() => {
    const overallDiscount = Number(values.discountPercent) || 0;
    const freight = Number(values.freightAmount) || 0;
    const computed = values.items.map((item) => {
      const product = productMap.get(item.productId);
      const qty = Number(item.quantity) || 0;
      const price = Number(item.unitPrice) || 0;
      const discount = Number(item.discountPercent) || 0;
      const lineSubtotal = qty * price;
      const lineTotal = lineSubtotal - lineSubtotal * (discount / 100);
      const gstPercent = product ? Number(product.gstPercent) : 0;
      return { lineTotal, gstPercent };
    });
    const subtotal = computed.reduce((sum, i) => sum + i.lineTotal, 0);
    const discountAmount = subtotal * (overallDiscount / 100);
    const taxAmount = computed.reduce((sum, i) => {
      const taxable = i.lineTotal * (1 - overallDiscount / 100);
      return sum + taxable * (i.gstPercent / 100);
    }, 0);
    const totalAmount = subtotal - discountAmount + taxAmount + freight;
    return { subtotal, discountAmount, taxAmount, totalAmount };
  }, [values.items, values.discountPercent, values.freightAmount, productMap]);

  function submit() {
    const validItems = values.items.filter((i) => i.productId && Number(i.quantity) > 0);
    if (validItems.length === 0) {
      toast.error("Add at least one product line.");
      return;
    }
    const payload: QuotationFormInput = {
      customerId: target === "customer" ? values.customerId : "",
      leadId: target === "lead" ? values.leadId : "",
      validUntil: values.validUntil,
      discountPercent: values.discountPercent,
      freightAmount: values.freightAmount,
      termsAndConditions: values.termsAndConditions,
      notes: values.notes,
      items: validItems.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        discountPercent: i.discountPercent,
      })),
    };
    startTransition(async () => {
      const result = quotationId
        ? await updateQuotation(quotationId, payload)
        : await createQuotation(payload);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(quotationId ? "Quotation updated." : "Quotation created.");
      router.push(`/quotations/${quotationId ?? result.id}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Linked To</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={target} onValueChange={(v) => setTarget(v as "customer" | "lead")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="customer">Customer</SelectItem>
                <SelectItem value="lead">Lead</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{target === "customer" ? "Customer" : "Lead"}</Label>
            {target === "customer" ? (
              <Select value={values.customerId} onValueChange={(v) => set("customerId")(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Select value={values.leadId} onValueChange={(v) => set("leadId")(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select lead" />
                </SelectTrigger>
                <SelectContent>
                  {leads.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Line Items</CardTitle>
          <Button size="sm" variant="outline" onClick={addItem}>
            <Plus /> Add Product
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[30%]">Product</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Unit Price</TableHead>
                <TableHead>Discount %</TableHead>
                <TableHead>Line Total</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {values.items.map((item, index) => {
                const product = productMap.get(item.productId);
                const qty = Number(item.quantity) || 0;
                const price = Number(item.unitPrice) || 0;
                const discount = Number(item.discountPercent) || 0;
                const lineSubtotal = qty * price;
                const lineTotal = lineSubtotal - lineSubtotal * (discount / 100);
                return (
                  <TableRow key={index}>
                    <TableCell>
                      <Select
                        value={item.productId}
                        onValueChange={(v) => onSelectProduct(index, v as string)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select product" />
                        </SelectTrigger>
                        <SelectContent>
                          {products.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name} ({p.sku})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {product && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Unit: {product.unit} · GST {Number(product.gstPercent)}%
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        className="w-20"
                        value={item.quantity}
                        onChange={(e) => updateItem(index, { quantity: e.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        className="w-28"
                        value={item.unitPrice}
                        onChange={(e) => updateItem(index, { unitPrice: e.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        className="w-20"
                        value={item.discountPercent}
                        onChange={(e) => updateItem(index, { discountPercent: e.target.value })}
                      />
                    </TableCell>
                    <TableCell className="text-sm font-medium">{inr(lineTotal)}</TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeItem(index)}
                        disabled={values.items.length === 1}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Terms & Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Valid Until</Label>
                <Input
                  type="date"
                  value={values.validUntil}
                  onChange={(e) => set("validUntil")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Overall Discount %</Label>
                <Input
                  type="number"
                  value={values.discountPercent}
                  onChange={(e) => set("discountPercent")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Freight (₹)</Label>
                <Input
                  type="number"
                  value={values.freightAmount}
                  onChange={(e) => set("freightAmount")(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Terms & Conditions</Label>
              <Textarea
                value={values.termsAndConditions}
                onChange={(e) => set("termsAndConditions")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Internal Notes</Label>
              <Textarea value={values.notes} onChange={(e) => set("notes")(e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{inr(totals.subtotal)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Discount</span>
              <span>− {inr(totals.discountAmount)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Tax (GST)</span>
              <span>{inr(totals.taxAmount)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Freight</span>
              <span>{inr(Number(values.freightAmount) || 0)}</span>
            </div>
            <div className="flex items-center justify-between border-t pt-2 text-base font-semibold">
              <span>Total</span>
              <span>{inr(totals.totalAmount)}</span>
            </div>
            <Button className="mt-3 w-full" onClick={submit} disabled={isPending}>
              {isPending ? "Saving…" : quotationId ? "Save Changes" : "Create Quotation"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
