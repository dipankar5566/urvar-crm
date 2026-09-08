import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function recordingsDir(): string {
  return path.resolve(process.env.CALL_RECORDINGS_DIR || "./storage/call-recordings");
}

function recordingFilePath(recordingSid: string): string {
  return path.join(recordingsDir(), `${recordingSid}.mp3`);
}

/**
 * Downloads a completed Plivo recording (which otherwise requires Plivo
 * Basic Auth — must be enabled in Console > Voice > Other Voice Settings >
 * "Basic Auth For Recording URLs", off by default — and is subject to
 * Plivo's own retention) into local disk storage, and returns the path our
 * own route handler serves it from.
 */
export async function saveRecordingLocally(
  recordingId: string,
  plivoRecordingUrl: string,
): Promise<string> {
  const auth = Buffer.from(`${env("PLIVO_AUTH_ID")}:${env("PLIVO_AUTH_TOKEN")}`).toString("base64");
  const url = /\.(mp3|wav)$/i.test(plivoRecordingUrl)
    ? plivoRecordingUrl
    : `${plivoRecordingUrl}.mp3`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to download Plivo recording ${recordingId}: ${res.status}`);
  }

  await mkdir(recordingsDir(), { recursive: true });
  await writeFile(recordingFilePath(recordingId), Buffer.from(await res.arrayBuffer()));

  return `/api/voice/recordings/${recordingId}`;
}

export async function readRecordingFile(recordingSid: string): Promise<Buffer> {
  return readFile(recordingFilePath(recordingSid));
}
