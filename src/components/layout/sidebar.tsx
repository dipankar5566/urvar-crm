"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icon";
import {
  NAV_ITEMS,
  NAV_SECTION_LABELS,
  ALWAYS_VISIBLE_HREFS,
  type NavItem,
} from "@/lib/constants/nav";
import { canAccess } from "@/lib/permissions";
import type { Role } from "@/generated/prisma/enums";
import { UserMenu } from "./user-menu";
import { useGlobalSearch } from "@/components/search/global-search";

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      key={item.href}
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon name={item.icon} className="h-4 w-4 shrink-0" />
      {item.label}
    </Link>
  );
}

/** Nav item list shared between the desktop sidebar and the mobile drawer. */
export function NavLinks({
  role,
  onNavigate,
}: {
  role: Role;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  const items = NAV_ITEMS.filter(
    (item) =>
      ALWAYS_VISIBLE_HREFS.has(item.href) ||
      canAccess(role, item.module, "read"),
  );

  function isActive(item: NavItem) {
    return (
      pathname === item.href ||
      (item.href !== "/dashboard" && pathname.startsWith(item.href))
    );
  }

  const main = items.filter((i) => !i.section);
  const sections: ("sales" | "admin")[] = ["sales", "admin"];

  return (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5 pb-3">
      {main.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          active={isActive(item)}
          onNavigate={onNavigate}
        />
      ))}

      {sections.map((section) => {
        const sectionItems = items.filter((i) => i.section === section);
        if (sectionItems.length === 0) return null;
        return (
          <div key={section} className="mt-1.5">
            <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
              {NAV_SECTION_LABELS[section]}
            </div>
            {sectionItems.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(item)}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        );
      })}
    </nav>
  );
}

export function Sidebar({
  role,
  name,
  email,
}: {
  role: Role;
  name: string;
  email: string;
}) {
  const openSearch = useGlobalSearch();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="flex h-[45px] items-center gap-2 border-b px-2.5">
        <Image src="/urvar-icon.png" alt="Urvar" width={28} height={28} className="rounded-md" />
        <span className="text-sm font-semibold">Urvar CRM</span>
      </div>

      <div className="px-2 pb-0.5 pt-1.5">
        <button
          type="button"
          onClick={openSearch}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="text-[13px]">Search</span>
          <span className="ml-auto rounded border px-1 font-mono text-[11px] text-tertiary-foreground">
            ⌘K
          </span>
        </button>
      </div>

      <NavLinks role={role} />

      <div className="border-t p-1.5">
        <UserMenu name={name} email={email} role={role} mode="expanded" />
      </div>
    </aside>
  );
}
