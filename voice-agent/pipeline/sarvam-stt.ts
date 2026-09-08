/**
 * Sarvam Saaras v3 streaming STT client — hand-rolled WebSocket (not
 * Sarvam's own SDK) since this needs to live inside the same process as the
 * Plivo <Stream> handler, forwarding decoded PCM frames as they arrive.
 *
 * Confirmed against Sarvam's own docs (2026-09-09, see the approved plan):
 * endpoint `wss://api.sarvam.ai/speech-to-text-realtime/ws`, auth via a
 * plain `API-SUBSCRIPTION-KEY` WebSocket header, defaults
 * `sample_rate=16000`/`encoding=linear16`/`model=saaras:v3-realtime` —
 * matching what Plivo's <Stream> sends, so no transcoding.
 *
 * NOT independently live-tested yet: the exact per-frame audio envelope
 * (raw binary WS frames vs. a JSON-wrapped message) and the precise
 * final-vs-partial transcript signal. Sending raw binary frames and
 * treating a `signal_type: "END_SPEECH"` VAD event as "final" is this
 * module's best-effort reading of the docs — confirm and adjust against a
 * real call before trusting `isFinal` for anything beyond suggestion
 * pacing (see Phase 1's "Done when": one real human-operated test call).
 */
import WebSocket from "ws";

const SARVAM_STT_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";

export type SttTranscript = { text: string; isFinal: boolean };

export type SarvamSttSession = {
  sendAudio: (chunk: Buffer) => void;
  close: () => void;
};

export function createSarvamSttSession(opts: {
  onTranscript: (t: SttTranscript) => void;
  onError: (err: Error) => void;
}): SarvamSttSession {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: SARVAM_API_KEY");

  const model = process.env.SARVAM_STT_MODEL || "saaras:v3-realtime";
  const url = `${SARVAM_STT_URL}?model=${encodeURIComponent(model)}&sample_rate=16000&encoding=linear16`;

  const ws = new WebSocket(url, {
    headers: { "API-SUBSCRIPTION-KEY": apiKey },
  });

  ws.on("open", () => console.log("[sarvam-stt] connected"));

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // shouldn't happen for STT server->client, defensive only
    try {
      const msg = JSON.parse(data.toString());
      if (typeof msg.transcript === "string" && msg.transcript.length > 0) {
        opts.onTranscript({
          text: msg.transcript,
          isFinal: msg.signal_type === "END_SPEECH",
        });
      }
    } catch {
      // non-JSON frame — ignore rather than crash the call
    }
  });

  ws.on("error", (err) => opts.onError(err instanceof Error ? err : new Error(String(err))));

  return {
    sendAudio(chunk: Buffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
