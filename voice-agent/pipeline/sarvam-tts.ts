/**
 * Sarvam Bulbul v3 streaming TTS client — hand-rolled WebSocket, same
 * reasoning as sarvam-stt.ts (needs to live in this process, streaming
 * synthesized audio straight into the Plivo <Stream> playback loop).
 *
 * Wire protocol per Sarvam's docs (see the plan's Vendor stack decision):
 * a `{"type":"config","data":{...}}` message first, then
 * `{"type":"text","data":{"text":...}}` per utterance, streaming back
 * base64 audio chunks. `output_audio_codec: "linear16"` at 16kHz matches
 * Plivo's playback format exactly (confirmed 16kHz is supported for
 * playAudio, not just capture — see AI_AUTONOMOUS mode in server.ts).
 *
 * NOT independently live-tested yet: exact response message field names
 * for the streamed audio chunks (assumed `{type:"audio", data:{audio:...}}`
 * per Sarvam's SDK docs summary) — adjust here first if a real call's TTS
 * never produces sound.
 */
import WebSocket from "ws";
import type { SarvamTtsLanguage } from "./tts-language.js";

const SARVAM_TTS_URL = "wss://api.sarvam.ai/text-to-speech/ws";

// Sarvam's own docs disagree with themselves on whether real-time streaming
// actually honors `output_audio_codec: "linear16"` or silently always
// returns MP3 — this settles it empirically instead of trusting either
// doc source. An MP3 frame starts with a recognizable sync word (0xFF
// followed by 0xE0-0xFF); raw linear16 PCM has no such fixed signature.
// If this ever logs "looks like MP3", `onAudioChunk`'s bytes are compressed
// audio being forwarded to Plivo mislabeled as raw PCM and need decoding
// first — see the AI Voice Agent investigation plan.
function logAudioMagicBytes(chunk: Buffer) {
  const looksLikeMp3 = chunk.length >= 2 && chunk[0] === 0xff && (chunk[1] & 0xe0) === 0xe0;
  console.log(
    `[sarvam-tts] first audio chunk magic bytes: ${chunk.subarray(0, 4).toString("hex")} (${looksLikeMp3 ? "looks like MP3" : "does not look like MP3 — likely raw PCM"})`,
  );
}

export type SarvamTtsSession = {
  speak: (text: string) => void;
  /** Tells Sarvam to synthesize whatever text is still buffered. Sarvam
   * accumulates across `text` messages and decides when to synthesize, so
   * without this the tail of a turn waits on the next turn's text or an
   * internal timeout. */
  flush: () => void;
  close: () => void;
};

/** Optional numeric tuning knob; ignored entirely when unset or unparseable
 * so a typo in .env can't silently send garbage to the API. */
function numericEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`[sarvam-tts] ignoring ${name}="${raw}" — not a number`);
    return null;
  }
  return value;
}

export function createSarvamTtsSession(opts: {
  /** Fixed BCP-47 voice language for this call — see tts-language.ts. */
  languageCode: SarvamTtsLanguage;
  onAudioChunk: (chunk: Buffer) => void;
  onError: (err: Error) => void;
}): SarvamTtsSession {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: SARVAM_API_KEY");

  const model = process.env.SARVAM_TTS_MODEL || "bulbul:v3";
  const speaker = process.env.SARVAM_TTS_VOICE || "shubh";
  const pace = numericEnv("SARVAM_TTS_PACE");
  const temperature = numericEnv("SARVAM_TTS_TEMPERATURE");
  const url = `${SARVAM_TTS_URL}?model=${encodeURIComponent(model)}`;

  // Sarvam closes this socket with code 408 ("left open without any
  // messages for too long") after a quiet lull between turns — confirmed
  // live in logs/voice-agent-error-16.log. Without a reconnect, `speak()`'s
  // readyState guard below would just keep dropping every reply for the
  // rest of the call, leaving the AI permanently mute after any long pause.
  // `ws`/`configSent` are reassigned by `connect()` on each (re)connect;
  // handlers close over a locally-scoped `sock` rather than the outer `ws`
  // so a handler never fires against a socket a later reconnect replaced.
  let ws: WebSocket;
  let configSent = false;
  let closedByCaller = false;
  let audioChunksReceived = 0;
  let pendingText: string | null = null;

  function sendText(text: string) {
    console.log(`[sarvam-tts] speak: "${text.slice(0, 150)}"`);
    ws.send(JSON.stringify({ type: "text", data: { text } }));
  }

  function connect() {
    const sock = new WebSocket(url, {
      headers: { "API-SUBSCRIPTION-KEY": apiKey },
    });
    ws = sock;
    configSent = false;

    sock.on("open", () => {
      sock.send(
        JSON.stringify({
          type: "config",
          data: {
            speaker,
            // Confirmed against Sarvam's current TTS streaming reference:
            // language_code IS required (unlike STT, TTS has no "auto" —
            // it needs one fixed BCP-47 code from a fixed enum since it has
            // to know what to synthesize, not detect). Resolved per lead
            // from their state by the caller — see tts-language.ts.
            language_code: opts.languageCode,
            // The real field name is `speech_sample_rate`, not
            // `target_sample_rate` (that was a guess that doesn't exist in
            // Sarvam's schema — unrecognized fields are silently ignored,
            // so this had never actually taken effect; Sarvam was generating
            // at bulbul:v3's real default of 24000 Hz while we told Plivo it
            // was 16000 Hz, a likely cause of "robotic"-sounding playback).
            output_audio_codec: "linear16",
            speech_sample_rate: 16000,
            // Normalizes numbers, abbreviations and mixed-script text
            // before synthesis — this agent constantly says things like
            // "২৫ কেজির vermicompost", which is exactly the case it helps.
            enable_preprocessing: true,
            // Voice character. Left as env knobs because which speaker and
            // pace sound "human" is a judgement call made by listening to
            // storage/voice-samples (npm run tts:samples), not something to
            // hardcode from documentation. bulbul:v3 accepts pace 0.5-2.0
            // and temperature 0.01-1.0; it does NOT support pitch/loudness.
            ...(pace != null ? { pace } : {}),
            ...(temperature != null ? { temperature } : {}),
          },
        }),
      );
      configSent = true;
      console.log("[sarvam-tts] connected, config sent");
      if (pendingText !== null) {
        const text = pendingText;
        pendingText = null;
        sendText(text);
      }
    });

    sock.on("message", (data, isBinary) => {
      if (isBinary) {
        audioChunksReceived++;
        if (audioChunksReceived === 1 || audioChunksReceived % 20 === 0) {
          console.log(`[sarvam-tts] received binary audio chunk #${audioChunksReceived}, ${data.toString("hex").length / 2} bytes`);
        }
        if (audioChunksReceived === 1) logAudioMagicBytes(data as Buffer);
        opts.onAudioChunk(data as Buffer);
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.log(`[sarvam-tts] non-JSON frame: ${data.toString().slice(0, 200)}`);
        return;
      }

      if (msg.type === "audio" && typeof (msg.data as Record<string, unknown> | undefined)?.audio === "string") {
        audioChunksReceived++;
        const audio = (msg.data as { audio: string }).audio;
        if (audioChunksReceived === 1 || audioChunksReceived % 20 === 0) {
          console.log(`[sarvam-tts] received JSON audio chunk #${audioChunksReceived}, ${audio.length} b64 chars`);
        }
        const decoded = Buffer.from(audio, "base64");
        if (audioChunksReceived === 1) logAudioMagicBytes(decoded);
        opts.onAudioChunk(decoded);
      } else if (msg.type === "error" || msg.event === "error") {
        opts.onError(new Error(JSON.stringify(msg).slice(0, 300)));
      } else {
        console.log(`[sarvam-tts] unhandled message: ${JSON.stringify(msg).slice(0, 300)}`);
      }
    });

    sock.on("close", (code, reason) => {
      console.log(`[sarvam-tts] closed, code=${code}, reason=${reason.toString().slice(0, 200)}, chunksReceived=${audioChunksReceived}`);
      if (!closedByCaller) {
        console.log("[sarvam-tts] unexpected close mid-call — reconnecting");
        connect();
      }
    });
    sock.on("error", (err) => opts.onError(err instanceof Error ? err : new Error(String(err))));
  }

  connect();

  return {
    speak(text: string) {
      if (closedByCaller) return;
      if (configSent && ws.readyState === WebSocket.OPEN) {
        sendText(text);
        return;
      }
      // Mid-(re)connect — queue the latest utterance instead of dropping it;
      // it's flushed once the new socket's config round-trip completes.
      console.log(`[sarvam-tts] speak() queued — configSent=${configSent}, readyState=${ws.readyState}`);
      pendingText = text;
    },
    flush() {
      if (closedByCaller || !configSent || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "flush", data: {} }));
    },
    close() {
      closedByCaller = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
