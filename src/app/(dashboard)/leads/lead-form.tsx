"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
  LEAD_SOURCE_LABELS,
  CUSTOMER_TYPE_LABELS,
} from "@/lib/constants/labels";
import { STATES, districtsForState } from "@/lib/constants/territories";
import { createLead, updateLead } from "./actions";
import type { LeadFormInput } from "@/lib/validations/lead";

type RepOption = { id: string; name: string };

type LeadFormValues = {
  name: string;
  companyName: string;
  contactPerson: string;
  phone: string;
  whatsapp: string;
  email: string;
  state: string;
  district: string;
  pincode: string;
  address: string;
  source: string;
  customerType: string;
  interestedProducts: string;
  expectedQuantity: string;
  expectedMonthlyValue: string;
  estimatedValue: string;
  cropInterest: string;
  isGovernmentTender: boolean;
  remarks: string;
  assignedToId: string;
};

const EMPTY: LeadFormValues = {
  name: "",
  companyName: "",
  contactPerson: "",
  phone: "",
  whatsapp: "",
  email: "",
  state: "",
  district: "",
  pincode: "",
  address: "",
  source: "DIRECT_CALL",
  customerType: "B2C_FARMER",
  interestedProducts: "",
  expectedQuantity: "",
  expectedMonthlyValue: "",
  estimatedValue: "",
  cropInterest: "",
  isGovernmentTender: false,
  remarks: "",
  assignedToId: "",
};

export function LeadForm({
  leadId,
  initialValues,
  reps,
  canAssign,
  currentUserId,
}: {
  leadId?: string;
  initialValues?: Partial<LeadFormValues>;
  reps: RepOption[];
  canAssign: boolean;
  currentUserId: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<LeadFormValues>({
    ...EMPTY,
    ...initialValues,
  });
  const [pending, startTransition] = useTransition();

  function set<K extends keyof LeadFormValues>(key: K, value: LeadFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: LeadFormInput = {
      ...values,
      assignedToId: values.assignedToId || undefined,
    };

    startTransition(async () => {
      const result = leadId
        ? await updateLead(leadId, payload)
        : await createLead(payload);

      if ("error" in result) {
        toast.error(result.error);
        return;
      }

      toast.success(leadId ? "Lead updated" : "Lead created");
      router.push(leadId ? `/leads/${leadId}` : `/leads/${result.id}`);
      router.refresh();
    });
  }

  const districts = values.state ? districtsForState(values.state) : [];

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contact Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              required
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="companyName">Company / Farm Name</Label>
            <Input
              id="companyName"
              value={values.companyName}
              onChange={(e) => set("companyName", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone *</Label>
            <Input
              id="phone"
              required
              value={values.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="whatsapp">WhatsApp Number</Label>
            <Input
              id="whatsapp"
              value={values.whatsapp}
              onChange={(e) => set("whatsapp", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={values.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contactPerson">Contact Person</Label>
            <Input
              id="contactPerson"
              value={values.contactPerson}
              onChange={(e) => set("contactPerson", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Location</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>State *</Label>
            <Select
              value={values.state || undefined}
              onValueChange={(v) => {
                set("state", v as string);
                set("district", "");
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select state" />
              </SelectTrigger>
              <SelectContent>
                {STATES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>District *</Label>
            <Select
              value={values.district || undefined}
              onValueChange={(v) => set("district", v as string)}
              disabled={!values.state}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select district" />
              </SelectTrigger>
              <SelectContent>
                {districts.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pincode">Pincode</Label>
            <Input
              id="pincode"
              value={values.pincode}
              onChange={(e) => set("pincode", e.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="address">Address</Label>
            <Textarea
              id="address"
              value={values.address}
              onChange={(e) => set("address", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lead Classification</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Customer Type *</Label>
            <Select
              value={values.customerType}
              onValueChange={(v) => set("customerType", v as string)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CUSTOMER_TYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Source *</Label>
            <Select
              value={values.source}
              onValueChange={(v) => set("source", v as string)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(LEAD_SOURCE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cropInterest">Crop Interest</Label>
            <Input
              id="cropInterest"
              value={values.cropInterest}
              onChange={(e) => set("cropInterest", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="interestedProducts">Interested Products</Label>
            <Input
              id="interestedProducts"
              value={values.interestedProducts}
              onChange={(e) => set("interestedProducts", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="expectedQuantity">Expected Quantity</Label>
            <Input
              id="expectedQuantity"
              value={values.expectedQuantity}
              onChange={(e) => set("expectedQuantity", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="estimatedValue">Estimated Value (₹)</Label>
            <Input
              id="estimatedValue"
              type="number"
              min="0"
              value={values.estimatedValue}
              onChange={(e) => set("estimatedValue", e.target.value)}
            />
          </div>
          {canAssign && (
            <div className="space-y-2">
              <Label>Assigned To</Label>
              <Select
                value={values.assignedToId || currentUserId}
                onValueChange={(v) => set("assignedToId", v as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {reps.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox
              id="isGovernmentTender"
              checked={values.isGovernmentTender}
              onCheckedChange={(checked) =>
                set("isGovernmentTender", checked === true)
              }
            />
            <Label htmlFor="isGovernmentTender" className="cursor-pointer">
              This is a government tender lead
            </Label>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="remarks">Remarks</Label>
            <Textarea
              id="remarks"
              value={values.remarks}
              onChange={(e) => set("remarks", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : leadId ? "Save Changes" : "Create Lead"}
        </Button>
      </div>
    </form>
  );
}
