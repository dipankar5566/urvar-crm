"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { convertLead } from "../actions";

export function ConvertButton({
  leadId,
  alreadyConverted,
}: {
  leadId: string;
  alreadyConverted: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onConvert() {
    startTransition(async () => {
      const result = await convertLead(leadId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `Converted to customer ${result.customerNumber ?? ""}`.trim(),
      );
      router.refresh();
    });
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="w-full"
      onClick={onConvert}
      disabled={pending || alreadyConverted}
    >
      <Trophy />
      {alreadyConverted ? "Already Converted" : pending ? "Converting…" : "Convert to Customer"}
    </Button>
  );
}
