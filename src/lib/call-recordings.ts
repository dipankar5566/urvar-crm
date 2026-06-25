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
 * Downloads a completed Twilio recording (which otherwise requires Twilio
 * Basic Auth and is subject to Twilio's own retention) into local disk
 * storage, and returns the path our own route handler serves it from.
 */
export async function saveRecordingLocally(
  recordingSid: string,
  twilioRecordingUrl: string,
): Promise<string> {
  const auth = Buffer.from(`${env("TWILIO_ACCOUNT_SID")}:${env("TWILIO_AUTH_TOKEN")}`).toString(
    "base64",
  );
  const res = await fetch(`${twilioRecordingUrl}.mp3`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to download Twilio recording ${recordingSid}: ${res.status}`);
  }

  await mkdir(recordingsDir(), { recursive: true });
  await writeFile(recordingFilePath(recordingSid), Buffer.from(await res.arrayBuffer()));

  return `/api/voice/recordings/${recordingSid}`;
}

export async function readRecordingFile(recordingSid: string): Promise<Buffer> {
  return readFile(recordingFilePath(recordingSid));
}
