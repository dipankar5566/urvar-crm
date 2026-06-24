"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { updateQuotationStatus } from "../actions";

export function QuotationStatusActions({
  quotationId,
  status,
  hasCustomer,
}: {
  quotationId: string;
  status: string;
  hasCustomer: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function transition(next: "SENT" | "ACCEPTED" | "REJECTED") {
    startTransition(async () => {
      const result = await updateQuotationStatus(quotationId, { status: next });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Quotation marked ${next.toLowerCase()}.`);
      router.refresh();
    });
  }

  if (status !== "DRAFT" && status !== "SENT") return null;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-2 py-3">
        {status === "DRAFT" && (
          <Button size="sm" onClick={() => transition("SENT")} disabled={isPending}>
            <Send /> Mark as Sent
          </Button>
        )}
        {status === "SENT" && (
          <>
            <Button
              size="sm"
              onClick={() => transition("ACCEPTED")}
              disabled={isPending || !hasCustomer}
              title={hasCustomer ? undefined : "Convert the lead to a customer first"}
            >
              <CheckCircle2 /> Mark Accepted
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => transition("REJECTED")}
              disabled={isPending}
            >
              <XCircle /> Mark Rejected
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
