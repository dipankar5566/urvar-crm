/**
 * Resolves a lead's district/crop into knowledge-graph facts, once, before a
 * call starts — never a live lookup mid-conversation (all.md's Guiding
 * Principle 5: the product catalogue preload exists for exactly the same
 * latency reason). See voice-agent/lib/neo4j.ts for the client this sits on.
 *
 * Explicitly out of scope for this phase: competitor/COMPETES_WITH data
 * (dropped in Phase 3 sub-planning — which competitor to address is only
 * known once the lead names one mid-call, which conflicts with the
 * resolve-before-call rule) and TARGETS_SEGMENT (no verified mapping yet
 * from Lead.customerType's fixed enum to the graph's independently-populated
 * CustomerSegment node ids — see all.md Phase 3).
 */
import { runReadQuery, getCached, setCached } from "./neo4j.js";

/** Flat, prompt-ready shape — mirrors pipeline/openai-agent.ts's
 * ProductBrief/LeadBrief convention of plain objects with no graph-driver
 * types leaking out. */
export type GraphFactsBrief = {
  suitableProducts: { product: string; stage: string | null }[];
  cropDeficiencies: { deficiency: string; treatedBy: string[] }[];
  district: {
    name: string;
    soilTypes: string[];
    deficiencies: { name: string; severity: string | null }[];
    zone: string | null;
    cropsGrownHere: string[];
  } | null;
  personas: { name: string; kind: string; preferredProducts: string[] }[];
};

export const EMPTY_GRAPH_FACTS: GraphFactsBrief = {
  suitableProducts: [],
  cropDeficiencies: [],
  district: null,
  personas: [],
};

export type GraphFactsInput = {
  district?: string | null;
  cropInterest?: string | null;
};

/** Best-effort free-text -> graph-node-id heuristic: Lead.district and
 * Lead.cropInterest are unconstrained free text (src/lib/validations/lead.ts
 * has no enum/allowlist for either), while graph nodes use fixed `id` slugs
 * populated independently by urvar-knowledge-graph's own ETL. A miss here is
 * expected and acceptable — this is a nice-to-have enrichment, not a
 * critical path, so no fuzzy-distance matching, just a slug guess plus a
 * case-insensitive name fallback, both in one query. */
function toSlugGuess(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function matchDistrict(raw: string | null | undefined): Promise<string | null> {
  if (!raw || !raw.trim()) return null;
  const guess = toSlugGuess(raw);
  const rows = await runReadQuery<{ id: string }>(
    `MATCH (d:District) WHERE d.id = $guess OR toLower(d.name) = toLower($raw) RETURN d.id AS id LIMIT 1`,
    { guess, raw },
  );
  return rows[0]?.id ?? null;
}

async function matchCrop(raw: string | null | undefined): Promise<string | null> {
  if (!raw || !raw.trim()) return null;
  const guess = toSlugGuess(raw);
  const rows = await runReadQuery<{ id: string }>(
    `MATCH (c:Crop) WHERE c.id = $guess OR toLower(c.name) = toLower($raw) RETURN c.id AS id LIMIT 1`,
    { guess, raw },
  );
  return rows[0]?.id ?? null;
}

async function fetchSuitableProducts(cropId: string): Promise<GraphFactsBrief["suitableProducts"]> {
  return runReadQuery<{ product: string; stage: string | null }>(
    `MATCH (p:Product)-[sf:SUITABLE_FOR]->(:Crop {id: $cropId})
     RETURN p.name AS product, sf.stage AS stage
     ORDER BY sf.stage`,
    { cropId },
  );
}

async function fetchCropDeficiencies(cropId: string): Promise<GraphFactsBrief["cropDeficiencies"]> {
  return runReadQuery<{ deficiency: string; treatedBy: string[] }>(
    `MATCH (:Crop {id: $cropId})-[:SUSCEPTIBLE_TO]->(def:Deficiency)
     OPTIONAL MATCH (p:Product)-[:TREATS_DEFICIENCY]->(def)
     RETURN def.name AS deficiency, collect(DISTINCT p.name) AS treatedBy`,
    { cropId },
  );
}

async function fetchDistrictContext(districtId: string): Promise<GraphFactsBrief["district"]> {
  const rows = await runReadQuery<{
    name: string;
    soilTypes: string[];
    deficiencies: { name: string; severity: string | null }[];
    zone: string | null;
    cropsGrownHere: string[];
  }>(
    `MATCH (d:District {id: $districtId})
     OPTIONAL MATCH (d)-[:HAS_SOIL_TYPE]->(soil:SoilType)
     OPTIONAL MATCH (d)-[hd:HAS_DEFICIENCY]->(def:Deficiency)
     OPTIONAL MATCH (d)-[:IN_ZONE]->(zone:AgroClimaticZone)
     OPTIONAL MATCH (crop:Crop)-[:GROWN_IN]->(d)
     RETURN d.name AS name,
            collect(DISTINCT soil.name) AS soilTypes,
            collect(DISTINCT {name: def.name, severity: hd.severity}) AS deficiencies,
            head(collect(DISTINCT zone.name)) AS zone,
            collect(DISTINCT crop.name) AS cropsGrownHere`,
    { districtId },
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    soilTypes: (row.soilTypes ?? []).filter(Boolean),
    // OPTIONAL MATCH with no deficiency still yields one row shaped
    // {name: null, severity: null} via collect() — drop it.
    deficiencies: (row.deficiencies ?? []).filter((d) => d?.name),
    zone: row.zone ?? null,
    cropsGrownHere: (row.cropsGrownHere ?? []).filter(Boolean),
  };
}

async function fetchPersonas(
  cropId: string | null,
  districtId: string | null,
): Promise<GraphFactsBrief["personas"]> {
  if (!cropId && !districtId) return [];
  return runReadQuery<{ name: string; kind: string; preferredProducts: string[] }>(
    `MATCH (persona:FarmerPersona)
     WHERE ($cropId IS NOT NULL AND (persona)-[:FOCUSES_ON]->(:Crop {id: $cropId}))
        OR ($districtId IS NOT NULL AND (persona)-[:ACTIVE_IN]->(:District {id: $districtId}))
     OPTIONAL MATCH (persona)-[:PREFERS]->(prod:Product)
     RETURN persona.name AS name, persona.kind AS kind, collect(DISTINCT prod.name) AS preferredProducts
     LIMIT 5`,
    { cropId, districtId },
  );
}

export async function resolveGraphFacts(lead: GraphFactsInput): Promise<GraphFactsBrief> {
  const [districtId, cropId] = await Promise.all([
    matchDistrict(lead.district),
    matchCrop(lead.cropInterest),
  ]);
  if (!districtId && !cropId) return EMPTY_GRAPH_FACTS;

  const cacheKey = `${districtId ?? "-"}::${cropId ?? "-"}`;
  const cached = getCached<GraphFactsBrief>(cacheKey);
  if (cached) return cached;

  const [suitableProducts, cropDeficiencies, district, personas] = await Promise.all([
    cropId ? fetchSuitableProducts(cropId) : Promise.resolve([]),
    cropId ? fetchCropDeficiencies(cropId) : Promise.resolve([]),
    districtId ? fetchDistrictContext(districtId) : Promise.resolve(null),
    fetchPersonas(cropId, districtId),
  ]);

  const facts: GraphFactsBrief = { suitableProducts, cropDeficiencies, district, personas };
  setCached(cacheKey, facts);
  return facts;
}
