/**
 * Local storage for user-uploaded documents.
 *
 * Deliberately mirrors src/lib/call-recordings.ts, which is the only other
 * thing in this app that puts a file on disk: an env-configurable directory,
 * a filename derived from a server-generated id, and a logical URL rather
 * than a filesystem path handed back to callers. Nothing user-supplied ever
 * reaches the path — the File row's cuid names the file, so a crafted
 * filename cannot escape the directory.
 *
 * This is the app's first real upload path. The existing spreadsheet import
 * parses in memory and keeps nothing, and checks neither size nor MIME type;
 * both are enforced here.
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { MAX_DOCUMENT_BYTES } from "./sarvam-vision";

/** What Sarvam's document API accepts, and therefore all we allow in. */
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);

/** Well below Sarvam's 200 MB ceiling: these are phone photos and scans, and
 * a smaller cap rejects a mistake far more cheaply than an upload that takes
 * a minute before failing. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function documentsDir(): string {
  return path.resolve(process.env.DOCUMENTS_DIR || "./storage/documents");
}

function extensionFor(mimeType: string): string {
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "image/png") return ".png";
  return ".jpg";
}

function documentFilePath(fileId: string, mimeType: string): string {
  return path.join(documentsDir(), `${fileId}${extensionFor(mimeType)}`);
}

export class UploadRejected extends Error {}

/**
 * Validates an upload before anything is stored or sent to Sarvam. Throws
 * UploadRejected with a message meant for the person who uploaded it.
 */
export function assertUploadAllowed(file: File): void {
  if (file.size === 0) {
    throw new UploadRejected("That file is empty.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadRejected(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new UploadRejected("That file is larger than the document service accepts.");
  }
  if (!ALLOWED_MIME.has(file.type)) {
    throw new UploadRejected("Upload a PDF, JPG or PNG.");
  }
}

/** Field-visit photos are phone camera shots, never sent to Sarvam. */
const ALLOWED_PHOTO_MIME = new Set(["image/jpeg", "image/png"]);
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Validates a field-visit check-in photo.
 *
 * Deliberately separate from assertUploadAllowed: that one gates what gets
 * sent to Sarvam's document API and is bounded by MAX_DOCUMENT_BYTES for that
 * reason. A check-in photo never goes near Sarvam, so borrowing that limit
 * would tie an unrelated feature's ceiling to a document service's. Only the
 * storage helpers below are shared, and those care about neither.
 */
export function assertPhotoUploadAllowed(file: File): void {
  if (file.size === 0) {
    throw new UploadRejected("That photo is empty.");
  }
  if (file.size > MAX_PHOTO_BYTES) {
    throw new UploadRejected(
      `That photo is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`,
    );
  }
  if (!ALLOWED_PHOTO_MIME.has(file.type)) {
    throw new UploadRejected("Upload a JPG or PNG photo.");
  }
}

/**
 * Writes an uploaded document to disk under a server-generated id.
 *
 * The caller creates the File row and passes its id, so the database row and
 * the file on disk always share a name and neither can be orphaned by a
 * filename collision.
 */
export async function saveDocument(fileId: string, mimeType: string, bytes: Buffer): Promise<string> {
  await mkdir(documentsDir(), { recursive: true });
  const filePath = documentFilePath(fileId, mimeType);
  await writeFile(filePath, bytes);
  return filePath;
}

export async function readDocument(fileId: string, mimeType: string): Promise<Buffer> {
  return readFile(documentFilePath(fileId, mimeType));
}

/** The route that serves this document back, never a filesystem path. */
export function documentUrl(fileId: string): string {
  return `/api/documents/${fileId}`;
}
