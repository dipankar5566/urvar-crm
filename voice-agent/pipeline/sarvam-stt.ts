/**
 * Sarvam Saaras v3 streaming STT client — hand-rolled WebSocket (not
 * Sarvam's own SDK) since this needs to live inside the same process as the
 * Plivo <Stream> handler, forwarding decoded PCM frames as they arrive.
 *
 * Wire protocol confirmed live against a real call (2026-09-09), not just
 * from docs — the docs' "{type, transcript}" summary was wrong for this
 * realtime endpoint. Real messages are: `{"event":"vad.speech_start"|
 * "vad.speech_end", utterance_idx, confidence}` and
 * `{"event":"transcript.partial"|"transcript.final", utterance_idx, text,
 * language, language_confidence}` — final text lands in `text`, not
 * `transcript`, and "final" is the `event` name itself, not a separate
 * `signal_type` field. `language_code=auto`+`mode=codemix` (also confirmed
 * required/live-verified — the connection is rejected without
 * language_code) correctly detected a mid-call language switch to Bengali
 * in testing (`language: "bn-IN"` on a `transcript.final` event).
 */
import WebSocket from "ws";

const SARVAM_STT_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";

/** ~2s of 20ms frames — enough to cover the handshake, small enough that a
 * socket which never opens can't accumulate unbounded audio. */
const MAX_PENDING_CHUNKS = 100;

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
  // language_code is required (confirmed live 2026-09-09: the connection
  // was rejected with "Missing required query parameter 'language_code'"
  // when omitted) — "auto" enables adaptive language detection, needed for
  // the Hindi/English/Bengali code-switching requirement. mode=codemix
  // produces native+English mixed output on final transcripts, confirmed
  // against Sarvam's own docs.
  // stream_type=fast is Sarvam's documented low-latency setting; the default
  // is "balanced". This is a live phone call, so partial/final latency
  // matters more here than the last few points of partial accuracy.
  // silence_duration_ms is the wait after the lead stops talking before a
  // final is emitted, and it is pure dead air on every single turn —
  // Sarvam's default is 500ms. 300ms measurably shortens the gap without
  // chopping mid-sentence pauses; lower starts clipping people who pause to
  // think mid-answer.
  const url = `${SARVAM_STT_URL}?model=${encodeURIComponent(model)}&sample_rate=16000&encoding=linear16&language_code=auto&mode=codemix&stream_type=fast&silence_duration_ms=300`;

  const ws = new WebSocket(url, {
    headers: { "API-SUBSCRIPTION-KEY": apiKey },
  });

  /** Frames that arrived while the socket was still connecting. */
  const pending: Buffer[] = [];

  ws.on("open", () => console.log(`[sarvam-stt] connected, url=${url}`));

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      console.log(`[sarvam-stt] unexpected binary frame, ${data.toString("hex").length / 2} bytes — ignored`);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.log(`[sarvam-stt] non-JSON frame: ${data.toString().slice(0, 200)}`);
      return;
    }

    if (
      (msg.event === "transcript.partial" || msg.event === "transcript.final") &&
      typeof msg.text === "string" &&
      msg.text.length > 0
    ) {
      if (msg.event === "transcript.final") {
        console.log(`[sarvam-stt] FINAL: "${msg.text}" (lang=${msg.language}, conf=${msg.language_confidence})`);
      }
      opts.onTranscript({ text: msg.text, isFinal: msg.event === "transcript.final" });
    } else if (msg.event === "vad.speech_start" || msg.event === "vad.speech_end") {
      // Expected, not a transcript — no action needed.
    } else if (msg.event === "error") {
      opts.onError(new Error(typeof msg.message === "string" ? msg.message : JSON.stringify(msg)));
    } else {
      // Logs the shape of anything else unrecognized, in case Sarvam's
      // protocol has more message types than confirmed so far.
      console.log(`[sarvam-stt] unhandled message: ${JSON.stringify(msg).slice(0, 300)}`);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[sarvam-stt] closed, code=${code}, reason=${reason.toString().slice(0, 200)}`);
  });
  ws.on("error", (err) => opts.onError(err instanceof Error ? err : new Error(String(err))));

  let audioChunksSent = 0;
  return {
    sendAudio(chunk: Buffer) {
      if (ws.readyState === WebSocket.OPEN) {
        // Flush anything captured during the handshake, oldest first, so the
        // lead's opening word survives.
        if (pending.length > 0) {
          const buffered = pending.splice(0, pending.length);
          console.log(`[sarvam-stt] flushing ${buffered.length} buffered chunk(s) captured before connect`);
          for (const b of buffered) ws.send(b);
          audioChunksSent += buffered.length;
        }
        ws.send(chunk);
        audioChunksSent++;
        if (audioChunksSent === 1 || audioChunksSent % 100 === 0) {
          console.log(`[sarvam-stt] sent audio chunk #${audioChunksSent}, ${chunk.length} bytes`);
        }
      } else if (ws.readyState === WebSocket.CONNECTING) {
        // The socket takes ~0.25-0.5s to come up while Plivo is already
        // streaming; these frames used to be dropped outright, which could
        // swallow the start of the lead's first sentence. Bounded so a
        // socket that never opens can't grow this without limit.
        if (pending.length < MAX_PENDING_CHUNKS) pending.push(chunk);
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
