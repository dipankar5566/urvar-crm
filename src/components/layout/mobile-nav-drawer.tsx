"use client";

import { useState } from "react";
import Image from "next/image";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { NavLinks } from "./sidebar";
import { UserMenu } from "./user-menu";
import type { Role } from "@/generated/prisma/enums";

export function MobileNavDrawer({
  role,
  name,
  email,
}: {
  role: Role;
  name: string;
  email: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Open navigation menu"
        onClick={() => setOpen(true)}
      >
        <Menu className="h-4 w-4" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 gap-0 p-0">
          <div className="flex h-[45px] items-center gap-2 border-b px-2.5">
            <Image src="/urvar-icon.png" alt="Urvar" width={28} height={28} className="rounded-md" />
            <SheetTitle className="text-sm font-semibold">
              Urvar CRM
            </SheetTitle>
          </div>
          <NavLinks role={role} onNavigate={() => setOpen(false)} />
          <div className="border-t p-1.5">
            <UserMenu name={name} email={email} role={role} mode="expanded" />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
