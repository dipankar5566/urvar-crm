"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Moon, Sun, ChevronLeft, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NAV_ITEMS } from "@/lib/constants/nav";
import { NotificationBell } from "./notification-bell";
import { UserMenu } from "./user-menu";
import { MobileNavDrawer } from "./mobile-nav-drawer";
import { useGlobalSearch } from "@/components/search/global-search";
import type { Role } from "@/generated/prisma/enums";

type NotificationItem = {
  id: string;
  title: string;
  body: string | null;
  isRead: boolean;
  createdAt: Date;
  relatedLeadId: string | null;
};

function resolvePage(pathname: string) {
  const matches = NAV_ITEMS.filter(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/"),
  ).sort((a, b) => b.href.length - a.href.length);
  const match = matches[0];
  if (!match) return { title: "Dashboard", backHref: null as string | null };
  const isSubPage = pathname !== match.href;
  return { title: match.label, backHref: isSubPage ? match.href : null };
}

export function Topbar({
  name,
  email,
  role,
  initialNotifications,
  initialUnreadCount,
}: {
  name: string;
  email: string;
  role: Role;
  initialNotifications: NotificationItem[];
  initialUnreadCount: number;
}) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const { title, backHref } = resolvePage(pathname);
  const openSearch = useGlobalSearch();

  return (
    <header className="flex h-[45px] items-center gap-1 border-b bg-background px-4">
      <MobileNavDrawer role={role} name={name} email={email} />
      {backHref && (
        <>
          <Link
            href={backHref}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <Link
            href={backHref}
            className="text-[13px] text-muted-foreground hover:text-foreground"
          >
            {title}
          </Link>
          <span className="px-0.5 text-[13px] text-tertiary-foreground">/</span>
        </>
      )}
      {!backHref && <span className="text-sm font-medium">{title}</span>}

      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          onClick={openSearch}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Search className="h-4 w-4" />
          <span className="hidden sm:inline">Search</span>
        </button>
        <NotificationBell
          initialNotifications={initialNotifications}
          initialUnreadCount={initialUnreadCount}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
        <UserMenu name={name} email={email} role={role} mode="compact" />
      </div>
    </header>
  );
}
