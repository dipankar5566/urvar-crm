"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { postPurchaseInvoiceAction } from "../actions";

export function PostInvoiceButton({ invoiceId }: { invoiceId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await postPurchaseInvoiceAction(invoiceId);
          if ("error" in result) {
            toast.error(result.error);
          } else {
            toast.success("Invoice posted to the ledger.");
            router.refresh();
          }
        })
      }
    >
      {pending ? "Posting…" : "Post to Ledger"}
    </Button>
  );
}
