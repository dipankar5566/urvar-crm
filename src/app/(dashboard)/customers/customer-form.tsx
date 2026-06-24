"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import { CUSTOMER_TYPE_LABELS } from "@/lib/constants/labels";
import { STATES, districtsForState } from "@/lib/constants/territories";
import { DEALER_TYPES } from "@/lib/validations/customer";
import { createCustomer, updateCustomer } from "./actions";
import type { CustomerFormInput } from "@/lib/validations/customer";

type RepOption = { id: string; name: string };

type CustomerFormValues = {
  name: string;
  companyName: string;
  contactPerson: string;
  customerType: string;
  phone: string;
  whatsapp: string;
  email: string;
  state: string;
  district: string;
  pincode: string;
  address: string;
  gstNumber: string;
  panNumber: string;
  creditLimit: string;
  outstandingAmount: string;
  dealerTier: string;
  territoryAssigned: string;
  annualTargetValue: string;
  assignedToId: string;
};

const EMPTY: CustomerFormValues = {
  name: "",
  companyName: "",
  contactPerson: "",
  customerType: "B2C_FARMER",
  phone: "",
  whatsapp: "",
  email: "",
  state: "",
  district: "",
  pincode: "",
  address: "",
  gstNumber: "",
  panNumber: "",
  creditLimit: "",
  outstandingAmount: "",
  dealerTier: "",
  territoryAssigned: "",
  annualTargetValue: "",
  assignedToId: "",
};

export function CustomerForm({
  customerId,
  initialValues,
  reps,
  canAssign,
  currentUserId,
}: {
  customerId?: string;
  initialValues?: Partial<CustomerFormValues>;
  reps: RepOption[];
  canAssign: boolean;
  currentUserId: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<CustomerFormValues>({
    ...EMPTY,
    ...initialValues,
  });
  const [pending, startTransition] = useTransition();

  function set<K extends keyof CustomerFormValues>(key: K, value: CustomerFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  const isDealerType = DEALER_TYPES.includes(values.customerType as never);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: CustomerFormInput = {
      ...values,
      dealerTier: isDealerType && values.dealerTier ? values.dealerTier : null,
      assignedToId: values.assignedToId || undefined,
    };

    startTransition(async () => {
      const result = customerId
        ? await updateCustomer(customerId, payload)
        : await createCustomer(payload);

      if ("error" in result) {
        toast.error(result.error);
        return;
      }

      toast.success(customerId ? "Customer updated" : "Customer created");
      router.push(customerId ? `/customers/${customerId}` : `/customers/${result.id}`);
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
          <CardTitle className="text-base">Classification</CardTitle>
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
            <Label htmlFor="gstNumber">GST Number</Label>
            <Input
              id="gstNumber"
              value={values.gstNumber}
              onChange={(e) => set("gstNumber", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="panNumber">PAN Number</Label>
            <Input
              id="panNumber"
              value={values.panNumber}
              onChange={(e) => set("panNumber", e.target.value)}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Financials</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="creditLimit">Credit Limit (₹)</Label>
            <Input
              id="creditLimit"
              type="number"
              min="0"
              value={values.creditLimit}
              onChange={(e) => set("creditLimit", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="outstandingAmount">Outstanding Amount (₹)</Label>
            <Input
              id="outstandingAmount"
              type="number"
              min="0"
              value={values.outstandingAmount}
              onChange={(e) => set("outstandingAmount", e.target.value)}
            />
          </div>
          {isDealerType && (
            <>
              <div className="space-y-2">
                <Label>Dealer Tier</Label>
                <Select
                  value={values.dealerTier || undefined}
                  onValueChange={(v) => set("dealerTier", v as string)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select tier" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GOLD">Gold</SelectItem>
                    <SelectItem value="SILVER">Silver</SelectItem>
                    <SelectItem value="BRONZE">Bronze</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="territoryAssigned">Territory Assigned</Label>
                <Input
                  id="territoryAssigned"
                  value={values.territoryAssigned}
                  onChange={(e) => set("territoryAssigned", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="annualTargetValue">Annual Target Value (₹)</Label>
                <Input
                  id="annualTargetValue"
                  type="number"
                  min="0"
                  value={values.annualTargetValue}
                  onChange={(e) => set("annualTargetValue", e.target.value)}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : customerId ? "Save Changes" : "Create Customer"}
        </Button>
      </div>
    </form>
  );
}
