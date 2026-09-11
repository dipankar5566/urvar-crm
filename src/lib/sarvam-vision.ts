/**
 * Sarvam document intelligence — pulls structured fields out of a scanned
 * or photographed document.
 *
 * Uses the **extract** endpoint, not digitise: extract takes a schema of the
 * fields we want and hands back their values, whereas digitise returns a ZIP
 * of Markdown plus per-page JSON that we would then have to parse ourselves.
 *
 * The API is a job queue, not a request/response call: submit, poll, fetch.
 * Endpoints and auth below were confirmed against the live API — the model's
 * own documentation page 404s.
 *
 * Limits that shape how this can be used (they apply on EVERY plan tier,
 * including Enterprise): 10 requests per minute, 10 pages per PDF, 200 MB.
 * Bulk backfills are therefore not possible; this is a one-document-at-a-time
 * feature by design, not by choice.
 */
const BASE = "https://api.sarvam.ai/doc-ai/v1";

/** How long to wait for a job before giving up. Real documents come back in
 * seconds; this only exists so a stuck job can't hang a request forever. */
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

/** Sarvam's own caps, surfaced so callers can reject a file before spending
 * one of our ten requests per minute on it. */
export const MAX_DOCUMENT_PAGES = 10;
export const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;

export type ExtractField = {
  /** Key the value comes back under. */
  name: string;
  /** Plain-language description — this is the only instruction the model
   * gets about what to look for, so it does the real work here. */
  description: string;
};

export type ExtractResult = {
  fields: Record<string, unknown>;
  /** Pages actually processed, for cost and truncation visibility. */
  pagesProcessed: number | null;
};

export class SarvamVisionError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SarvamVisionError";
  }
}

function apiKey(): string {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new SarvamVisionError("Missing required env var: SARVAM_API_KEY");
  return key;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sarvam wants a real JSON Schema object, not a field/description map. A
 * plain `{fieldName: "what to look for"}` is rejected with
 * `SCHEMA_INVALID: schema property contains unsupported key "..."`, which
 * reads like a problem with the field name rather than the shape — the
 * documentation only says "JSON string defining fields", so this was
 * established by probing the live endpoint.
 */
function buildJsonSchema(fields: ExtractField[]): string {
  return JSON.stringify({
    type: "object",
    properties: Object.fromEntries(
      fields.map((f) => [f.name, { type: "string", description: f.description }]),
    ),
  });
}

async function createExtractJob(file: File, fields: ExtractField[], language: string): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  body.append("language", language);
  body.append("output_format", "json");
  body.append("schema", buildJsonSchema(fields));

  const res = await fetch(`${BASE}/job/extract`, {
    method: "POST",
    headers: { "api-subscription-key": apiKey() },
    body,
  });

  if (res.status === 429) {
    throw new SarvamVisionError(
      "Sarvam is rate limiting document extraction (10 per minute). Wait a minute and try again.",
      429,
    );
  }
  if (!res.ok) {
    throw new SarvamVisionError(`Could not start extraction: ${(await res.text()).slice(0, 200)}`, res.status);
  }

  const { job_id: jobId } = (await res.json()) as { job_id?: string };
  if (!jobId) throw new SarvamVisionError("Sarvam accepted the document but returned no job id");
  return jobId;
}

async function waitForJob(jobId: string): Promise<number | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/job/${jobId}/status`, {
      headers: { "api-subscription-key": apiKey() },
    });
    if (!res.ok) {
      throw new SarvamVisionError(`Could not check extraction status: ${res.status}`, res.status);
    }

    const status = (await res.json()) as {
      status?: string;
      usage?: { pages_processed?: number };
      error?: unknown;
    };

    switch (status.status) {
      // partially_completed still carries usable output — a 12-page scan
      // whose first 10 pages parsed beats nothing, and the caller sees
      // pagesProcessed and can say so.
      case "completed":
      case "partially_completed":
        return status.usage?.pages_processed ?? null;
      case "failed":
      case "error":
        throw new SarvamVisionError(
          `Sarvam could not read this document: ${JSON.stringify(status.error ?? {}).slice(0, 200)}`,
        );
      default:
        await sleep(POLL_INTERVAL_MS);
    }
  }

  throw new SarvamVisionError("Extraction timed out. The document may be too large or unusually complex.");
}

/**
 * Extracts the requested fields from one document.
 *
 * Throws SarvamVisionError with a message safe to show a user — callers are
 * server actions and routes whose failures surface directly in the UI.
 */
export async function extractFromDocument(
  file: File,
  fields: ExtractField[],
  /** Document language hint, not the CRM's UI language. */
  language = "en-IN",
): Promise<ExtractResult> {
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new SarvamVisionError("That file is larger than the 200 MB limit.");
  }
  if (fields.length === 0) {
    throw new SarvamVisionError("No fields were requested from the document.");
  }

  const jobId = await createExtractJob(file, fields, language);
  const pagesProcessed = await waitForJob(jobId);

  const res = await fetch(`${BASE}/job/${jobId}/results`, {
    headers: { "api-subscription-key": apiKey() },
  });
  if (!res.ok) {
    throw new SarvamVisionError(`Could not fetch extraction results: ${res.status}`, res.status);
  }

  const payload = (await res.json()) as { result?: Record<string, unknown> };
  return { fields: payload.result ?? {}, pagesProcessed };
}
