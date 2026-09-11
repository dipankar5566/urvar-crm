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
  targetCrops: string;
  problemSolved: string;
  dosage: string;
  applicationMethod: string;
  nutrientContent: string;
  benefits: string;
  objectionNotes: string;
  availability: string;
};

/** The agronomy fields, rendered as one block. Labelled with what the AI does
 * with each, because whoever fills these in is writing words a farmer will
 * hear on the phone — and anything left blank makes the agent offer a callback
 * rather than improvise. */
const AGRONOMY_FIELDS: { key: keyof FormValues; label: string; placeholder: string }[] = [
  { key: "targetCrops", label: "Target crops", placeholder: "Paddy, potato, vegetables" },
  { key: "problemSolved", label: "Problem it solves", placeholder: "Low soil fertility, poor root development" },
  { key: "dosage", label: "Dosage", placeholder: "e.g. 2 bags per bigha — leave blank unless confirmed" },
  { key: "applicationMethod", label: "How to apply", placeholder: "Broadcast before sowing, mix into topsoil" },
  { key: "nutrientContent", label: "Nutrient content", placeholder: "e.g. N 1.2%, P 0.8%, K 1.0%" },
  { key: "benefits", label: "Benefits", placeholder: "What it does — never a promised yield figure" },
  { key: "objectionNotes", label: "Objection notes", placeholder: "What to say when a customer pushes back on this product" },
  { key: "availability", label: "Availability", placeholder: "In stock, 3-4 days for delivery" },
];

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
  targetCrops: "",
  problemSolved: "",
  dosage: "",
  applicationMethod: "",
  nutrientContent: "",
  benefits: "",
  objectionNotes: "",
  availability: "",
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
      targetCrops: values.targetCrops,
      problemSolved: values.problemSolved,
      dosage: values.dosage,
      applicationMethod: values.applicationMethod,
      nutrientContent: values.nutrientContent,
      benefits: values.benefits,
      objectionNotes: values.objectionNotes,
      availability: values.availability,
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

          <div className="space-y-3 border-t pt-4">
            <div>
              <h3 className="text-sm font-medium">Agronomy details</h3>
              <p className="text-muted-foreground text-xs">
                Used by the AI caller when a farmer asks. Leave a field blank if it is not
                confirmed — the agent then offers a callback instead of guessing.
              </p>
            </div>
            {AGRONOMY_FIELDS.map(({ key, label, placeholder }) => (
              <div key={key} className="space-y-1.5">
                <Label>{label}</Label>
                <Textarea
                  rows={2}
                  placeholder={placeholder}
                  value={values[key]}
                  onChange={(e) => set(key)(e.target.value)}
                />
              </div>
            ))}
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
