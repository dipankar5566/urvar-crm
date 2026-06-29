"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CALL_OUTCOME_LABELS } from "@/lib/constants/labels";
import { completeVoiceCall } from "@/app/(dashboard)/calls/voice-actions";
import { useCall } from "./call-provider";

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ActiveCallBar() {
  const router = useRouter();
  const { status, activeCall, durationSeconds, isMuted, hangUp, toggleMute, dismiss } = useCall();
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState("CONNECTED");
  const [notes, setNotes] = useState("");

  if (status === "idle" || !activeCall) return null;

  function submitOutcome() {
    startTransition(async () => {
      const result = await completeVoiceCall(activeCall!.callId, { outcome, notes });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Call logged");
      setOutcome("CONNECTED");
      setNotes("");
      dismiss();
      router.refresh();
    });
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border bg-card shadow-lg">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div>
          <p className="text-sm font-medium">
            {activeCall.leadName ?? activeCall.customerName ?? "Call"}
          </p>
          <p className="text-xs text-muted-foreground">
            {status === "connecting" && "Connecting…"}
            {status === "in-progress" && formatDuration(durationSeconds)}
            {status === "wrapping-up" && "Call ended"}
          </p>
        </div>
        {status === "in-progress" && (
          <div className="flex gap-1">
            <Button variant="outline" size="icon" onClick={toggleMute} aria-label="Toggle mute">
              {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
            <Button variant="destructive" size="icon" onClick={hangUp} aria-label="Hang up">
              <PhoneOff className="h-4 w-4" />
            </Button>
          </div>
        )}
        {status === "connecting" && (
          <Button variant="destructive" size="icon" onClick={hangUp} aria-label="Cancel">
            <PhoneOff className="h-4 w-4" />
          </Button>
        )}
      </div>

      {status === "wrapping-up" && (
        <div className="space-y-2 p-4">
          <Select value={outcome} onValueChange={(v) => setOutcome(v as string)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CALL_OUTCOME_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            placeholder="Notes about this call…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <Button onClick={submitOutcome} disabled={pending} className="w-full">
            <Phone className="h-4 w-4" /> {pending ? "Saving…" : "Save Call"}
          </Button>
        </div>
      )}
    </div>
  );
}
