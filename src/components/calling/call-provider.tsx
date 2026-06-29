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
import { Device, type Call } from "@twilio/voice-sdk";
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

export function CallProvider({ children }: { children: ReactNode }) {
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [deviceReady, setDeviceReady] = useState(false);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [isMuted, setIsMuted] = useState(false);

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
      const { token } = await res.json();

      const device = new Device(token, { logLevel: "warn" });
      deviceRef.current = device;

      device.on("registered", () => setDeviceReady(true));
      device.on("unregistered", () => setDeviceReady(false));
      device.on("error", (err) => {
        toast.error(`Calling error: ${err.message}`);
      });
      device.on("tokenWillExpire", async () => {
        const r = await fetch("/api/voice/token");
        if (r.ok) {
          const { token: newToken } = await r.json();
          device.updateToken(newToken);
        }
      });

      await device.register();
    }

    setup();

    return () => {
      cancelled = true;
      stopTimer();
      deviceRef.current?.destroy();
      deviceRef.current = null;
    };
  }, [stopTimer]);

  const startCall = useCallback(
    (params: ActiveCall) => {
      const device = deviceRef.current;
      if (!device || !deviceReady) {
        toast.error("Calling isn't ready yet — try again in a moment.");
        return;
      }
      if (callRef.current) {
        toast.error("A call is already in progress.");
        return;
      }

      setActiveCall(params);
      setStatus("connecting");
      setDurationSeconds(0);
      setIsMuted(false);

      device
        .connect({ params: { callId: params.callId } })
        .then((call) => {
          callRef.current = call;
          call.on("accept", () => {
            setStatus("in-progress");
            stopTimer();
            timerRef.current = setInterval(() => {
              setDurationSeconds((d) => d + 1);
            }, 1000);
          });
          call.on("disconnect", () => {
            stopTimer();
            callRef.current = null;
            setStatus("wrapping-up");
          });
          call.on("cancel", () => {
            stopTimer();
            callRef.current = null;
            setStatus("idle");
            setActiveCall(null);
          });
          call.on("error", (err) => {
            toast.error(`Call error: ${err.message}`);
          });
        })
        .catch((err: Error) => {
          toast.error(`Could not start call: ${err.message}`);
          setStatus("idle");
          setActiveCall(null);
        });
    },
    [deviceReady, stopTimer],
  );

  const hangUp = useCallback(() => {
    callRef.current?.disconnect();
  }, []);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const next = !isMuted;
    call.mute(next);
    setIsMuted(next);
  }, [isMuted]);

  const dismiss = useCallback(() => {
    setStatus("idle");
    setActiveCall(null);
    setDurationSeconds(0);
  }, []);

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
