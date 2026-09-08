"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { initiateAiCall } from "../../calls/ai-voice-actions";

/**
 * Phase 2 — places a fully autonomous AI outbound call (no human on the
 * line). Sibling to call-button.tsx, gated separately by the ai_calls
 * module rather than plain calls write.
 */
export function AiCallButton({ leadId, className }: { leadId: string; className?: string }) {
  const [pending, startTransition] = useTransition();
  const [placed, setPlaced] = useState(false);

  function handleClick() {
    startTransition(async () => {
      const result = await initiateAiCall(leadId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("AI is calling the lead now.");
      setPlaced(true);
    });
  }

  return (
    <Button
      variant="outline"
      className={cn("w-full justify-start", className)}
      onClick={handleClick}
      disabled={pending || placed}
    >
      <Sparkles className="h-4 w-4" /> {pending ? "Placing call…" : placed ? "AI calling…" : "AI Call"}
    </Button>
  );
}
