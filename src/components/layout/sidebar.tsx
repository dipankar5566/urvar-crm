"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icon";
import { NAV_ITEMS, ALWAYS_VISIBLE_HREFS } from "@/lib/constants/nav";
import { canAccess } from "@/lib/permissions";
import type { Role } from "@/generated/prisma/enums";

export function Sidebar({ role }: { role: Role }) {
  const pathname = usePathname();

  const items = NAV_ITEMS.filter(
    (item) =>
      ALWAYS_VISIBLE_HREFS.has(item.href) ||
      canAccess(role, item.module, "read"),
  );

  return (
    <aside className="hidden w-60 shrink-0 border-r bg-card md:flex md:flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-green-600 text-sm font-bold text-white">
          U
        </div>
        <span className="font-semibold">Urvar CRM</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {items.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon name={item.icon} className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
