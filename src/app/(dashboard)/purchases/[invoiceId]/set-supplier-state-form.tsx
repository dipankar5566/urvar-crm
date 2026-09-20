"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { STATES } from "@/lib/constants/territories";
import { setSupplierStateAction } from "../actions";

export function SetSupplierStateForm({ supplierId }: { supplierId: string }) {
  const [state, setState] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <Select value={state} onValueChange={(v) => setState(v ?? "")}>
        <SelectTrigger className="w-56">
          <SelectValue placeholder="Select state" />
        </SelectTrigger>
        <SelectContent>
          {STATES.map((s) => (
            <SelectItem key={s} value={s}>{s}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        disabled={pending || !state}
        onClick={() =>
          start(async () => {
            const result = await setSupplierStateAction(supplierId, state);
            if ("error" in result) {
              toast.error(result.error);
            } else {
              toast.success("Supplier state saved.");
              router.refresh();
            }
          })
        }
      >
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
