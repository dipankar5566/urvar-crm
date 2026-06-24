"use client";

import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { PlusIcon, XIcon } from "lucide-react";
import { CUSTOMER_TYPE_LABELS } from "@/lib/constants/labels";
import { STATES } from "@/lib/constants/territories";

type RepOption = { id: string; name: string };

export function CustomerFilters({
  reps,
  showRepFilter,
  newHref = "/customers/new",
  typeOptions,
}: {
  reps: RepOption[];
  showRepFilter: boolean;
  newHref?: string;
  typeOptions?: [string, string][];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "ALL") params.delete(key);
    else params.set(key, value);
    router.push(`${pathname}?${params.toString()}`);
  }

  const hasFilters = searchParams.size > 0;
  const entries = typeOptions ?? Object.entries(CUSTOMER_TYPE_LABELS);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={searchParams.get("customerType") ?? "ALL"}
        onValueChange={(v) => setParam("customerType", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue placeholder="Type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All types</SelectItem>
          {entries.map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={searchParams.get("state") ?? "ALL"}
        onValueChange={(v) => setParam("state", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue placeholder="State" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All states</SelectItem>
          {STATES.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showRepFilter && (
        <Select
          value={searchParams.get("assignedToId") ?? "ALL"}
          onValueChange={(v) => setParam("assignedToId", v as string)}
        >
          <SelectTrigger size="sm">
            <SelectValue placeholder="Assigned to" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All reps</SelectItem>
            <SelectItem value="UNASSIGNED">Unassigned</SelectItem>
            {reps.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={() => router.push(pathname)}>
          <XIcon /> Clear
        </Button>
      )}

      <Button size="sm" className="ml-auto" render={<Link href={newHref} />}>
        <PlusIcon /> New Customer
      </Button>
    </div>
  );
}
