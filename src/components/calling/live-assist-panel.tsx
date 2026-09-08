"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getAssistToken } from "@/app/(dashboard)/calls/voice-actions";
import { useCall } from "./call-provider";

type TranscriptLine = { id: number; text: string; final: boolean };
type Suggestion = { id: number; text: string };

/**
 * AI Voice Agent (Phase 1): passive live-assist overlay shown alongside
 * <ActiveCallBar> when a call was started with the "AI Assist" toggle on.
 * Connects directly to voice-agent's /assist/{callId} WebSocket (not
 * through the Next.js server — this is a raw client-to-voice-agent
 * connection, authorized by a short-lived signed token from
 * `getAssistToken`, since voice-agent can't read the Better Auth session).
 */
export function LiveAssistPanel() {
  const { status, activeCall } = useCall();
  const enabled = Boolean(activeCall?.aiAssist) && (status === "connecting" || status === "in-progress");

  if (!enabled || !activeCall) return null;

  // Keyed on callId so each call gets a fresh WS connection and transcript
  // state via remount, rather than resetting state imperatively inside an
  // effect (which cascades renders — see react-hooks/set-state-in-effect).
  return <LiveAssistPanelInner key={activeCall.callId} callId={activeCall.callId} />;
}

function LiveAssistPanelInner({ callId }: { callId: string }) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "error">(
    "connecting",
  );
  const wsRef = useRef<WebSocket | null>(null);
  const nextId = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const result = await getAssistToken(callId);
      if (cancelled) return;
      if ("error" in result) {
        setConnectionState("error");
        return;
      }

      const base = process.env.NEXT_PUBLIC_VOICE_AGENT_WS_URL;
      if (!base) {
        setConnectionState("error");
        return;
      }

      const ws = new WebSocket(`${base}/assist/${callId}?token=${result.token}`);
      wsRef.current = ws;

      ws.onopen = () => !cancelled && setConnectionState("connected");
      ws.onerror = () => !cancelled && setConnectionState("error");
      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "transcript" && msg.final) {
            setLines((prev) => [...prev, { id: nextId.current++, text: msg.text, final: true }]);
          } else if (msg.type === "suggestion") {
            setSuggestions((prev) => [...prev, { id: nextId.current++, text: msg.text }]);
          }
          // "call-ended" messages carry a final summary — the transcript
          // detail page (calls/[callId]) is the source of truth for that
          // once persisted, so this panel doesn't duplicate it here.
        } catch {
          // ignore malformed frames
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [callId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, suggestions]);

  return (
    <div className="fixed bottom-4 right-[22rem] z-50 w-96 rounded-lg border bg-card shadow-lg">
      <Card className="border-0 shadow-none">
        <CardHeader className="flex-row items-center justify-between space-y-0 border-b py-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-primary" /> AI Assist
          </div>
          {connectionState === "connecting" && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          {connectionState === "error" && (
            <Badge variant="destructive" className="text-[10px]">
              Disconnected
            </Badge>
          )}
        </CardHeader>
        <CardContent className="max-h-80 space-y-2 overflow-y-auto p-3 text-sm">
          {lines.length === 0 && suggestions.length === 0 && (
            <p className="text-xs text-muted-foreground">Listening…</p>
          )}
          {lines.map((line) => (
            <p key={line.id} className="text-muted-foreground">
              {line.text}
            </p>
          ))}
          {suggestions.map((s) => (
            <div
              key={s.id}
              className="rounded-md border border-primary/30 bg-primary/5 p-2 text-xs font-medium text-primary"
            >
              {s.text}
            </div>
          ))}
          <div ref={bottomRef} />
        </CardContent>
      </Card>
    </div>
  );
}
