"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

type UserOption = { id: string; name: string };

export function AuditLogFilters({
  entityTypes,
  actions,
  users,
}: {
  entityTypes: string[];
  actions: string[];
  users: UserOption[];
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={searchParams.get("entityType") ?? "ALL"}
        onValueChange={(v) => setParam("entityType", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue placeholder="Entity" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All entities</SelectItem>
          {entityTypes.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={searchParams.get("action") ?? "ALL"}
        onValueChange={(v) => setParam("action", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue placeholder="Action" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All actions</SelectItem>
          {actions.map((a) => (
            <SelectItem key={a} value={a}>
              {a}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={searchParams.get("userId") ?? "ALL"}
        onValueChange={(v) => setParam("userId", v as string)}
      >
        <SelectTrigger size="sm">
          <SelectValue placeholder="User" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All users</SelectItem>
          {users.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={() => router.push(pathname)}>
          <XIcon /> Clear
        </Button>
      )}
    </div>
  );
}
