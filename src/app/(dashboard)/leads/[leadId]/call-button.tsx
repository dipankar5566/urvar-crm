"use client";

import { useTransition } from "react";
import { Phone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCall } from "@/components/calling/call-provider";
import { initiateCall } from "../../calls/voice-actions";

export function CallButton({ leadId, leadName }: { leadId: string; leadName: string }) {
  const { startCall, status, deviceReady } = useCall();
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await initiateCall(leadId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      startCall({ callId: result.id!, leadId, leadName });
    });
  }

  return (
    <Button
      variant="outline"
      className="w-full justify-start"
      onClick={handleClick}
      disabled={pending || status !== "idle" || !deviceReady}
    >
      <Phone className="h-4 w-4" /> {pending ? "Connecting…" : "Call"}
    </Button>
  );
}
