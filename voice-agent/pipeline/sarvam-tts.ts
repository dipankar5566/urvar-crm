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

const SARVAM_TTS_URL = "wss://api.sarvam.ai/text-to-speech/ws";

export type SarvamTtsSession = {
  speak: (text: string) => void;
  close: () => void;
};

export function createSarvamTtsSession(opts: {
  onAudioChunk: (chunk: Buffer) => void;
  onError: (err: Error) => void;
}): SarvamTtsSession {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: SARVAM_API_KEY");

  const model = process.env.SARVAM_TTS_MODEL || "bulbul:v3";
  const speaker = process.env.SARVAM_TTS_VOICE || "shubh";
  const url = `${SARVAM_TTS_URL}?model=${encodeURIComponent(model)}`;

  const ws = new WebSocket(url, {
    headers: { "API-SUBSCRIPTION-KEY": apiKey },
  });

  let configSent = false;
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "config",
        data: {
          speaker,
          // language_code left unset — Bulbul's docs advertise code-mixed
          // text handling, so the AI's own English-with-code-switched-terms
          // output should be handled without pinning a single language.
          output_audio_codec: "linear16",
          target_sample_rate: 16000,
        },
      }),
    );
    configSent = true;
    console.log("[sarvam-tts] connected, config sent");
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      opts.onAudioChunk(data as Buffer);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "audio" && typeof msg.data?.audio === "string") {
        opts.onAudioChunk(Buffer.from(msg.data.audio, "base64"));
      }
    } catch {
      // non-JSON, non-binary frame — ignore
    }
  });

  ws.on("error", (err) => opts.onError(err instanceof Error ? err : new Error(String(err))));

  return {
    speak(text: string) {
      if (!configSent || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "text", data: { text } }));
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
