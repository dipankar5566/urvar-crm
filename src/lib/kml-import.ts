/**
 * Turns a KML export of dealer/distributor pins (district cluster files
 * produced outside this app) into candidate lead rows, shaped exactly like a
 * row parsed from a spreadsheet — see lead-document-extract.ts for why that
 * shape is the whole point: it rides the same duplicate-detection, Zod
 * validation and human-preview path a spreadsheet row takes, instead of
 * growing a second, less careful import pipeline.
 *
 * KML has no header row, so unlike a spreadsheet there is no column-mapping
 * step to skip past — this module goes straight from <Placemark> to a row
 * keyed by the importer's own field names (see DOCUMENT_COLUMN_MAPPING in
 * lead-document-extract.ts for the same identity-mapping trick).
 */
import { XMLParser } from "fast-xml-parser";
import type { ImportTargetField } from "./lead-import";

type KmlDataEntry = { "@_name"?: string; value?: unknown };
type KmlPlacemarkNode = {
  name?: unknown;
  description?: unknown;
  ExtendedData?: { Data?: KmlDataEntry | KmlDataEntry[] };
};
type KmlFolderNode = { Placemark?: KmlPlacemarkNode | KmlPlacemarkNode[] };
type KmlDocumentNode = { Folder?: KmlFolderNode | KmlFolderNode[]; Placemark?: KmlPlacemarkNode | KmlPlacemarkNode[] };

export type RawPlacemark = {
  /** Raw <name> text, e.g. "#2 Pallishree Limited [A+]" — rank/tier still attached. */
  name?: string;
  /** Raw HTML description block (entities already decoded). */
  description?: string;
  /** <ExtendedData><Data name="X"><value>Y</value></Data></ExtendedData> as a flat map. */
  extendedData: Record<string, string>;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  htmlEntities: true,
  // Force these to always be arrays regardless of count — otherwise a
  // single-Placemark file parses to an object instead of a one-item array.
  isArray: (name) => name === "Placemark" || name === "Data" || name === "Folder",
});

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Extracts every <Placemark> from a KML document, across all its folders. */
export function parseKmlPlacemarks(xml: string): RawPlacemark[] {
  const parsed = parser.parse(xml) as { kml?: { Document?: KmlDocumentNode } };
  const doc = parsed.kml?.Document;
  if (!doc) throw new Error("Not a recognizable KML file.");

  const folders = toArray(doc.Folder);
  const placemarkNodes = folders.length > 0
    ? folders.flatMap((f) => toArray(f.Placemark))
    : toArray(doc.Placemark);

  return placemarkNodes.map((p) => {
    const extendedData: Record<string, string> = {};
    for (const entry of toArray(p.ExtendedData?.Data)) {
      const key = entry["@_name"];
      if (key) extendedData[key] = String(entry.value ?? "").trim();
    }
    return {
      name: typeof p.name === "string" ? p.name : undefined,
      description: typeof p.description === "string" ? p.description : undefined,
      extendedData,
    };
  });
}

/** Census-style district spellings used in the source data -> the spellings
 * already used elsewhere in this CRM's addresses and customer records. */
const DISTRICT_SPELLINGS: Record<string, string> = {
  Hugli: "Hooghly",
  Haora: "Howrah",
  Maldah: "Malda",
  Barddhaman: "Bardhaman",
  Darjiling: "Darjeeling",
  "Uttar Dinajpur": "North Dinajpur",
  "Dakshin Dinajpur": "South Dinajpur",
};

/** Pulls "<b>Label:</b> value" out of the placemark's HTML description block. */
function extractDescField(description: string, label: string): string | undefined {
  const match = description.match(new RegExp(`<b>${label}:</b>\\s*([^<]*)`, "i"));
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

/** Strips the "#12 " sales-rank prefix and "[A+]" tier suffix off a placemark name. */
function cleanName(raw: string): string {
  return raw.replace(/^#\d+\s+/, "").replace(/\s*\[[^\]]+\]\s*$/, "").trim();
}

/** Pulls the first plausible 10-digit Indian mobile number out of a raw phone
 * string. The source data mixes clean mobiles with landlines (STD-code
 * prefixed), multiple comma-separated numbers, and "Nil"/"Unavailable" — this
 * is deliberately strict (must start 6-9, exactly 10 digits) rather than
 * accepting anything phone-shaped, because Lead.phone drives click-to-call
 * and a landline stored there would silently break dialling. */
function extractMobile(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, "");
  return digits.match(/[6-9]\d{9}/)?.[0];
}

export type KmlLeadRow = Partial<Record<ImportTargetField, string>>;

/**
 * Maps one placemark to a candidate lead row, or null if it has no usable
 * mobile number (Lead.phone is required and feeds click-to-call, so these
 * are skipped rather than imported half-broken — see the KML import plan).
 */
export function kmlPlacemarkToLeadRow(p: RawPlacemark, sourceLabel: string): KmlLeadRow | null {
  const rawPhone = p.extendedData.Phone ?? "";
  const phone = extractMobile(rawPhone);
  if (!phone) return null;

  const rawName = p.name?.trim() || "Unnamed dealer";
  const name = cleanName(rawName) || rawName;

  const description = p.description ?? "";
  const district = extractDescField(description, "District");
  const address = extractDescField(description, "Address");
  const normalizedDistrict = district ? (DISTRICT_SPELLINGS[district] ?? district) : "";

  const cluster = p.extendedData.Cluster;
  const tier = p.extendedData.Tier;
  const estimatedLifting = p.extendedData["Estimated lifting"];

  const remarks = [
    `Imported from KML: ${sourceLabel}`,
    cluster && `Cluster: ${cluster}`,
    tier && `Prospect tier: ${tier}`,
    rawName !== name && `Original listing: ${rawName}`,
    rawPhone && rawPhone.replace(/\D/g, "") !== phone && `Phone on file: ${rawPhone}`,
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    name,
    phone,
    state: "West Bengal",
    district: normalizedDistrict,
    address,
    source: "OTHER",
    customerType: "B2B_DEALER",
    expectedQuantity: estimatedLifting || undefined,
    remarks,
  };
}

/** Parses a whole KML file into candidate lead rows, dropping placemarks
 * with no usable phone number and reporting how many were dropped. */
export function kmlToLeadRows(
  xml: string,
  sourceLabel: string,
): { rows: Record<string, string>[]; skippedCount: number } {
  const placemarks = parseKmlPlacemarks(xml);
  const rows: Record<string, string>[] = [];
  let skippedCount = 0;

  for (const placemark of placemarks) {
    const row = kmlPlacemarkToLeadRow(placemark, sourceLabel);
    if (row) {
      rows.push(row as Record<string, string>);
    } else {
      skippedCount++;
    }
  }

  return { rows, skippedCount };
}
