"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
// Type-only import — the runtime module references `window` at load time and
// must never be statically imported, or "use client" SSR evaluation crashes
// with "ReferenceError: window is not defined". Loaded via dynamic import()
// inside the client-only useEffect below instead.
import type Plivo from "plivo-browser-sdk";
import { toast } from "sonner";

export type CallStatus = "idle" | "connecting" | "in-progress" | "wrapping-up";

type ActiveCall = {
  callId: string;
  leadId?: string;
  leadName?: string;
  customerId?: string;
  customerName?: string;
};

type CallContextValue = {
  status: CallStatus;
  activeCall: ActiveCall | null;
  durationSeconds: number;
  isMuted: boolean;
  deviceReady: boolean;
  startCall: (params: ActiveCall) => void;
  hangUp: () => void;
  toggleMute: () => void;
  dismiss: () => void;
};

const CallContext = createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within <CallProvider>");
  return ctx;
}

type PlivoClient = InstanceType<typeof Plivo>["client"];

/** Minimal shape of what Plivo's call lifecycle events pass their listener —
 * not independently confirmed against a live call; verify on first test call. */
type PlivoCallInfo = { callUUID?: string; reason?: string; code?: number };

export function CallProvider({ children }: { children: ReactNode }) {
  const clientRef = useRef<PlivoClient | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);

  const [deviceReady, setDeviceReady] = useState(false);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [isMuted, setIsMuted] = useState(false);

  const setActiveCallBoth = useCallback((value: ActiveCall | null) => {
    activeCallRef.current = value;
    setActiveCall(value);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function setup() {
      const res = await fetch("/api/voice/token");
      if (!res.ok || cancelled) return;
      const { username, password } = await res.json();

      const { default: PlivoCtor } = await import("plivo-browser-sdk");
      const sdk = new PlivoCtor({ debug: "WARN", permOnClick: true });
      const client = sdk.client;
      clientRef.current = client;

      // Unlike Twilio's per-call `Call` object, the Browser SDK v2 reports
      // call state via these GLOBAL client events — safe here because the
      // app only ever allows one active call at a time (see startCall).
      client.on("onLogin", () => setDeviceReady(true));
      client.on("onLoginFailed", () => {
        setDeviceReady(false);
        toast.error("Calling could not connect — try refreshing the page.");
      });
      client.on("onLogout", () => setDeviceReady(false));

      client.on("onCalling", () => setStatus("connecting"));
      client.on("onCallRemoteRinging", () => setStatus("connecting"));
      client.on("onCallAnswered", () => {
        setStatus("in-progress");
        stopTimer();
        timerRef.current = setInterval(() => {
          setDurationSeconds((d) => d + 1);
        }, 1000);
      });
      client.on("onCallTerminated", () => {
        stopTimer();
        setStatus("wrapping-up");
      });
      client.on("onCallFailed", (info?: PlivoCallInfo) => {
        stopTimer();
        toast.error(`Call error: ${info?.reason || "unknown error"}`);
        setStatus("idle");
        setActiveCallBoth(null);
      });

      client.login(username, password);
    }

    setup();

    return () => {
      cancelled = true;
      stopTimer();
      clientRef.current?.logout();
      clientRef.current = null;
    };
  }, [stopTimer, setActiveCallBoth]);

  const startCall = useCallback(
    (params: ActiveCall) => {
      const client = clientRef.current;
      if (!client || !deviceReady) {
        toast.error("Calling isn't ready yet — try again in a moment.");
        return;
      }
      if (activeCallRef.current) {
        toast.error("A call is already in progress.");
        return;
      }

      setActiveCallBoth(params);
      setStatus("connecting");
      setDurationSeconds(0);
      setIsMuted(false);

      // The destination argument below is never actually dialed — the
      // server-side answer_url XML resolves who to call from `callId`,
      // never trusting a client-supplied phone number. Plivo's call()
      // still requires *some* string here, so we pass the callId itself.
      const ok = client.call(params.callId, { "X-PH-CallId": params.callId });
      if (!ok) {
        toast.error("Could not start call.");
        setStatus("idle");
        setActiveCallBoth(null);
      }
    },
    [deviceReady, setActiveCallBoth],
  );

  const hangUp = useCallback(() => {
    clientRef.current?.hangup();
  }, []);

  const toggleMute = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    const next = !isMuted;
    if (next) {
      client.mute();
    } else {
      client.unmute();
    }
    setIsMuted(next);
  }, [isMuted]);

  const dismiss = useCallback(() => {
    setStatus("idle");
    setActiveCallBoth(null);
    setDurationSeconds(0);
  }, [setActiveCallBoth]);

  return (
    <CallContext.Provider
      value={{
        status,
        activeCall,
        durationSeconds,
        isMuted,
        deviceReady,
        startCall,
        hangUp,
        toggleMute,
        dismiss,
      }}
    >
      {children}
    </CallContext.Provider>
  );
}
