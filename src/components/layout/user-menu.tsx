"use client";

import { useRouter } from "next/navigation";
import { LogOut, MoreHorizontal, User as UserIcon } from "lucide-react";
import { signOut } from "@/lib/auth-client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLE_LABELS } from "@/lib/constants/labels";
import { initialsOf } from "@/lib/avatar";
import { cn } from "@/lib/utils";

export function UserMenu({
  name,
  email,
  role,
  mode,
}: {
  name: string;
  email: string;
  role: string;
  mode: "compact" | "expanded";
}) {
  const router = useRouter();
  const initials = initialsOf(name);

  async function handleSignOut() {
    await signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex items-center rounded-md text-sm hover:bg-accent focus-visible:outline-none",
          mode === "compact"
            ? "gap-2 px-2 py-1.5"
            : "w-full gap-2 px-2 py-1.5 text-left",
        )}
      >
        <Avatar className={mode === "compact" ? "h-7 w-7" : "h-7 w-7 shrink-0"}>
          <AvatarFallback className="bg-[#2383E2] text-xs text-white">
            {initials}
          </AvatarFallback>
        </Avatar>
        {mode === "compact" ? (
          <span className="hidden sm:inline">{name}</span>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium leading-tight text-foreground">
                {name}
              </div>
              <div className="truncate text-[11px] leading-tight text-muted-foreground">
                {ROLE_LABELS[role] ?? role}
              </div>
            </div>
            <MoreHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span>{name}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {email}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <UserIcon className="mr-2 h-4 w-4" />
          {ROLE_LABELS[role] ?? role}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut}>
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
