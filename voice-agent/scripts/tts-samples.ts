/**
 * Renders the same agent line through a spread of Sarvam TTS settings so a
 * human can listen and pick one — voice quality is a judgement call that
 * can't be made from byte counts or docs.
 *
 * Writes playable .wav files to storage/voice-samples/ (gitignored, same
 * tree as call recordings). Sarvam streams raw headerless PCM, which no
 * media player will open, so each file gets a 44-byte RIFF header.
 *
 * Run:  npm run tts:samples
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const OUT_DIR = path.join(process.cwd(), "storage", "voice-samples");

/** A realistic turn: code-mixed Bengali/English plus a number, which is
 * exactly what enable_preprocessing is supposed to handle. */
const LINE_PARTS = [
  "হ্যালো দীপঙ্করবাবু,",
  "উর্বর ন্যাচারাল থেকে বলছি।",
  "আপনি কি এখনও জৈব সার নেওয়ার কথা ভাবছেন? আমাদের ২৫ কেজির vermicompost প্যাক আছে।",
];
const LINE_WHOLE = LINE_PARTS.join(" ");

type Variant = {
  file: string;
  note: string;
  speaker?: string;
  sampleRate?: number;
  pace?: number;
  temperature?: number;
  preprocessing?: boolean;
  /** Reproduce today's behaviour: separate text messages, spread over time,
   * never flushed. */
  fragmented?: boolean;
};

const VARIANTS: Variant[] = [
  { file: "01-baseline-what-you-heard", note: "shubh, fragmented, no preprocessing, no flush — current behaviour", fragmented: true },
  { file: "02-fixed-shubh", note: "shubh, whole line, preprocessing, flush", preprocessing: true },
  { file: "03-aditya", note: "aditya (male)", speaker: "aditya", preprocessing: true },
  { file: "04-rahul", note: "rahul (male)", speaker: "rahul", preprocessing: true },
  { file: "05-amit", note: "amit (male)", speaker: "amit", preprocessing: true },
  { file: "06-ritu", note: "ritu (female)", speaker: "ritu", preprocessing: true },
  { file: "07-priya", note: "priya (female)", speaker: "priya", preprocessing: true },
  { file: "08-shreya", note: "shreya (female)", speaker: "shreya", preprocessing: true },
  { file: "09-shubh-pace-0.9", note: "shubh, slightly slower", preprocessing: true, pace: 0.9 },
  { file: "10-shubh-warmer", note: "shubh, pace 0.95 + temperature 0.8", preprocessing: true, pace: 0.95, temperature: 0.8 },
  { file: "11-shubh-8khz-phone", note: "8kHz — roughly what the phone network delivers", preprocessing: true, sampleRate: 8000 },
];

/** Minimal RIFF/WAVE header for 16-bit mono PCM. */
function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); // PCM chunk size
  h.writeUInt16LE(1, 20); // format = PCM
  h.writeUInt16LE(1, 22); // channels
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 2 bytes/sample)
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function render(v: Variant, apiKey: string): Promise<void> {
  const sampleRate = v.sampleRate ?? 16000;
  const model = process.env.SARVAM_TTS_MODEL || "bulbul:v3";

  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://api.sarvam.ai/text-to-speech/ws?model=${encodeURIComponent(model)}`, {
      headers: { "API-SUBSCRIPTION-KEY": apiKey },
    });
    const parts: Buffer[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already closing */ }
      const pcm = Buffer.concat(parts);
      if (pcm.length === 0) {
        console.log(`  ${v.file.padEnd(30)} FAILED (no audio) — ${v.note}`);
        return resolve();
      }
      const out = path.join(OUT_DIR, `${v.file}.wav`);
      fs.writeFileSync(out, Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]));
      console.log(`  ${v.file.padEnd(30)} ${(pcm.length / 2 / sampleRate).toFixed(2)}s  — ${v.note}`);
      resolve();
    };

    ws.on("open", async () => {
      ws.send(
        JSON.stringify({
          type: "config",
          data: {
            speaker: v.speaker ?? process.env.SARVAM_TTS_VOICE ?? "shubh",
            language_code: "bn-IN",
            output_audio_codec: "linear16",
            speech_sample_rate: sampleRate,
            ...(v.preprocessing ? { enable_preprocessing: true } : {}),
            ...(v.pace != null ? { pace: v.pace } : {}),
            ...(v.temperature != null ? { temperature: v.temperature } : {}),
          },
        }),
      );

      if (v.fragmented) {
        // Same shape as the live bug: one message per clause, spread out,
        // and no flush at the end.
        for (const part of LINE_PARTS) {
          ws.send(JSON.stringify({ type: "text", data: { text: part } }));
          await sleep(600);
        }
      } else {
        ws.send(JSON.stringify({ type: "text", data: { text: LINE_WHOLE } }));
        ws.send(JSON.stringify({ type: "flush", data: {} }));
      }
      setTimeout(finish, 12000);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return void parts.push(data as Buffer);
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "audio" && typeof msg.data?.audio === "string") {
          parts.push(Buffer.from(msg.data.audio, "base64"));
        } else if (msg.type === "error" || msg.event === "error") {
          console.log(`  ${v.file.padEnd(30)} error: ${JSON.stringify(msg).slice(0, 140)}`);
        }
      } catch { /* non-JSON frame */ }
    });

    ws.on("error", (err) => {
      console.log(`  ${v.file.padEnd(30)} socket error: ${String(err).slice(0, 100)}`);
      finish();
    });
  });
}

async function main() {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: SARVAM_API_KEY");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Rendering ${VARIANTS.length} samples to ${OUT_DIR}\n`);
  for (const v of VARIANTS) await render(v, apiKey);
  console.log(`\nDone. Play them in order — 01 is what you heard, 02 is the same voice after the mechanical fixes.`);
}

main();
