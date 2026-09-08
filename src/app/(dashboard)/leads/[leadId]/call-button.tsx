"use client";

import { useState, useTransition } from "react";
import { Phone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useCall } from "@/components/calling/call-provider";
import { initiateCall } from "../../calls/voice-actions";

export function CallButton({
  leadId,
  leadName,
  className,
  canAiAssist = false,
}: {
  leadId: string;
  leadName: string;
  className?: string;
  /** Shows the "AI Assist" opt-in toggle — gated by the ai_calls module. */
  canAiAssist?: boolean;
}) {
  const { startCall, status, deviceReady } = useCall();
  const [pending, startTransition] = useTransition();
  const [aiAssist, setAiAssist] = useState(false);

  function handleClick() {
    startTransition(async () => {
      const result = await initiateCall({ leadId }, aiAssist);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      startCall({ callId: result.id!, leadId, leadName, aiAssist });
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="outline"
        className={cn("w-full justify-start", className)}
        onClick={handleClick}
        disabled={pending || status !== "idle" || !deviceReady}
      >
        <Phone className="h-4 w-4" /> {pending ? "Connecting…" : "Call"}
      </Button>
      {canAiAssist && (
        <div className="flex items-center gap-1.5">
          <Checkbox
            id={`ai-assist-${leadId}`}
            checked={aiAssist}
            onCheckedChange={(checked) => setAiAssist(checked === true)}
            disabled={pending || status !== "idle"}
          />
          <Label htmlFor={`ai-assist-${leadId}`} className="cursor-pointer text-xs text-muted-foreground">
            AI Assist (live transcript + suggestions)
          </Label>
        </div>
      )}
    </div>
  );
}
