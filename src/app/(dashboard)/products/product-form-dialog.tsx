"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { PRODUCT_CATEGORY_LABELS } from "@/lib/constants/labels";
import { createProduct, updateProduct } from "./actions";
import type { ProductFormInput } from "@/lib/validations/product";

type FormValues = {
  sku: string;
  name: string;
  category: string;
  hsnCode: string;
  description: string;
  unit: string;
  packSize: string;
  mrp: string;
  dealerPrice: string;
  distributorPrice: string;
  gstPercent: string;
};

const EMPTY: FormValues = {
  sku: "",
  name: "",
  category: "VERMICOMPOST",
  hsnCode: "",
  description: "",
  unit: "",
  packSize: "",
  mrp: "",
  dealerPrice: "",
  distributorPrice: "",
  gstPercent: "5",
};

export function ProductFormDialog({
  productId,
  initialValues,
}: {
  productId?: string;
  initialValues?: FormValues;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FormValues>(initialValues ?? EMPTY);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const isEdit = Boolean(productId);

  const set = <K extends keyof FormValues>(key: K) => (value: FormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  function submit() {
    const payload: ProductFormInput = {
      sku: values.sku,
      name: values.name,
      category: values.category,
      hsnCode: values.hsnCode,
      description: values.description,
      unit: values.unit,
      packSize: values.packSize,
      mrp: values.mrp,
      dealerPrice: values.dealerPrice,
      distributorPrice: values.distributorPrice,
      gstPercent: values.gstPercent,
    };
    startTransition(async () => {
      const result = isEdit
        ? await updateProduct(productId!, payload)
        : await createProduct(payload);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(isEdit ? "Product updated." : "Product created.");
      setOpen(false);
      if (!isEdit) setValues(EMPTY);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button size={isEdit ? "icon" : "default"} variant={isEdit ? "ghost" : "default"} />}
      >
        {isEdit ? (
          <Pencil className="h-4 w-4" />
        ) : (
          <>
            <Plus /> New Product
          </>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Product" : "New Product"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>SKU</Label>
              <Input value={values.sku} onChange={(e) => set("sku")(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={values.category} onValueChange={(v) => set("category")(v as string)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PRODUCT_CATEGORY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={values.name} onChange={(e) => set("name")(e.target.value)} />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Unit</Label>
              <Input
                placeholder="kg / litre / bag"
                value={values.unit}
                onChange={(e) => set("unit")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Pack Size</Label>
              <Input
                placeholder="25kg bag"
                value={values.packSize}
                onChange={(e) => set("packSize")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>HSN Code</Label>
              <Input value={values.hsnCode} onChange={(e) => set("hsnCode")(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1.5">
              <Label>MRP (₹)</Label>
              <Input
                type="number"
                value={values.mrp}
                onChange={(e) => set("mrp")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Dealer Price</Label>
              <Input
                type="number"
                value={values.dealerPrice}
                onChange={(e) => set("dealerPrice")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Distributor Price</Label>
              <Input
                type="number"
                value={values.distributorPrice}
                onChange={(e) => set("distributorPrice")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>GST %</Label>
              <Input
                type="number"
                value={values.gstPercent}
                onChange={(e) => set("gstPercent")(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              value={values.description}
              onChange={(e) => set("description")(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending}>
            {isEdit ? "Save Changes" : "Create Product"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
