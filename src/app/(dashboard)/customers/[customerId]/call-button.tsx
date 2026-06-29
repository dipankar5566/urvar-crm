"use client";

import { useTransition } from "react";
import { Phone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCall } from "@/components/calling/call-provider";
import { initiateCall } from "../../calls/voice-actions";

export function CallButton({
  customerId,
  customerName,
  className,
}: {
  customerId: string;
  customerName: string;
  className?: string;
}) {
  const { startCall, status, deviceReady } = useCall();
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await initiateCall({ customerId });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      startCall({ callId: result.id!, customerId, customerName });
    });
  }

  return (
    <Button
      variant="outline"
      className={cn("w-full justify-start", className)}
      onClick={handleClick}
      disabled={pending || status !== "idle" || !deviceReady}
    >
      <Phone className="h-4 w-4" /> {pending ? "Connecting…" : "Call"}
    </Button>
  );
}
