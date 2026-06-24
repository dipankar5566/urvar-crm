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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLE_LABELS } from "@/lib/constants/labels";
import { STATES } from "@/lib/constants/territories";
import { createUser, updateUser } from "./actions";

type FormValues = {
  name: string;
  email: string;
  password: string;
  role: string;
  phone: string;
  territoryStates: string[];
  isActive: boolean;
};

const EMPTY: FormValues = {
  name: "",
  email: "",
  password: "",
  role: "SALES_EXECUTIVE",
  phone: "",
  territoryStates: [],
  isActive: true,
};

export function UserFormDialog({
  userId,
  initialValues,
  isSelf = false,
}: {
  userId?: string;
  initialValues?: Omit<FormValues, "password">;
  isSelf?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FormValues>(
    initialValues ? { ...initialValues, password: "" } : EMPTY,
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const isEdit = Boolean(userId);

  const set = <K extends keyof FormValues>(key: K) => (value: FormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  function toggleState(state: string) {
    setValues((prev) => ({
      ...prev,
      territoryStates: prev.territoryStates.includes(state)
        ? prev.territoryStates.filter((s) => s !== state)
        : [...prev.territoryStates, state],
    }));
  }

  function submit() {
    startTransition(async () => {
      const result = isEdit
        ? await updateUser(userId!, {
            name: values.name,
            role: values.role,
            phone: values.phone,
            territoryStates: values.territoryStates,
            isActive: values.isActive,
          })
        : await createUser({
            name: values.name,
            email: values.email,
            password: values.password,
            role: values.role,
            phone: values.phone,
            territoryStates: values.territoryStates,
          });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(isEdit ? "User updated." : "User created.");
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
            <Plus /> New User
          </>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit User" : "New User"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={values.name} onChange={(e) => set("name")(e.target.value)} />
          </div>

          {!isEdit && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={values.email}
                  onChange={(e) => set("email")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Temporary Password</Label>
                <Input
                  type="password"
                  value={values.password}
                  onChange={(e) => set("password")(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select
                value={values.role}
                onValueChange={(v) => set("role")(v as string)}
                disabled={isSelf}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={values.phone} onChange={(e) => set("phone")(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Territory States</Label>
            <div className="flex flex-wrap gap-3 rounded-md border p-3">
              {STATES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={values.territoryStates.includes(s)}
                    onCheckedChange={() => toggleState(s)}
                  />
                  {s}
                </label>
              ))}
            </div>
          </div>

          {isEdit && !isSelf && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.isActive}
                onCheckedChange={(checked) => set("isActive")(checked === true)}
              />
              Active
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending}>
            {isEdit ? "Save Changes" : "Create User"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
