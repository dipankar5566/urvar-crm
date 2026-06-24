"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setProductActive } from "./actions";

export function ProductActiveToggle({
  productId,
  isActive,
}: {
  productId: string;
  isActive: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function toggle() {
    startTransition(async () => {
      const result = await setProductActive(productId, !isActive);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(isActive ? "Product deactivated." : "Product activated.");
      router.refresh();
    });
  }

  return (
    <Button size="icon" variant="ghost" onClick={toggle} disabled={isPending}>
      <Power className={isActive ? "h-4 w-4 text-destructive" : "h-4 w-4 text-emerald-600"} />
    </Button>
  );
}
