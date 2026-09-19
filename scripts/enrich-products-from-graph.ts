/**
 * Fills the CRM catalogue's agronomy columns from the knowledge graph.
 *
 * Why this exists: the four active Product rows shipped with 0 of 8 agronomy
 * fields filled and no description, so catalogueFacts() in
 * voice-agent/pipeline/openai-agent.ts rendered four bare names and the AI
 * caller had nothing to say about any of them. Two real callers asked whether
 * we had anything besides vermicompost and got no answer. The graph — loaded
 * out-of-repo by urvar-knowledge-graph — already holds the real spec sheets.
 *
 *   npx tsx scripts/enrich-products-from-graph.ts           dry run, prints a diff
 *   npx tsx scripts/enrich-products-from-graph.ts --apply   writes
 *
 * Dry run by default on purpose. all.md records that the graph mixes
 * Urvar-curated facts with lower-confidence third-party ones, and everything
 * written here ends up spoken to a customer, so a human reads the diff first.
 *
 * It only ever writes what the graph states literally. Nothing is inferred:
 * prisma/schema.prisma is explicit that the agronomy columns may not be
 * model-generated, and dosage/applicationMethod are absent from the graph
 * entirely, so they stay NULL and the agent keeps offering a callback for
 * them — which is the designed behaviour for a blank field.
 */
import "dotenv/config";
import neo4j, { type Driver } from "neo4j-driver";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

/**
 * CRM sku -> knowledge-graph node id.
 *
 * Explicit and hand-checked rather than fuzzy-matched on name: the two
 * catalogues were authored separately and not one of the four names matches
 * exactly (the CRM says "Liquid Humic Acid" where the graph says "Humic Acid
 * — Liquid Bio-Stimulant"), so a name heuristic that looked fine today would
 * silently mis-enrich a product the day someone renames one.
 *
 * The graph holds four more products the CRM does not stock (PROM Humic
 * Enriched, PROM Humic Based Flowering Booster, Zinc EDTA 12%, Boron EDTA).
 * They are deliberately absent here — the CRM catalogue is the source of
 * truth for what may be sold, and adding them is a business decision rather
 * than a data-plumbing one.
 */
const SKU_TO_GRAPH_ID: Record<string, string> = {
  URNP0108: "enriched-vermicompost",
  URNP0109: "prom-phosphate-rich-organic-manure",
  URNP0110: "humic-acid-liquid-bio-stimulant",
  URNP0111: "cow-dung-manure-fym",
};

/**
 * Spec properties in the order they should be read aloud, with the label the
 * agent will actually say. N-P-K first because that is what a buyer asks
 * about; shelf life last because nobody leads with it.
 *
 * Labels are plain ASCII on purpose: this string is spoken by Sarvam's TTS,
 * and "P2O5" is read correctly where a subscript character is not.
 */
const NUTRIENT_FIELDS: [prop: string, label: string][] = [
  ["nitrogen_n", "N"],
  ["phosphorus_p2o5", "P2O5"],
  ["total_phosphorus_p2o5", "P2O5"],
  ["potassium_k2o", "K2O"],
  ["zinc_zn_chelated", "chelated zinc"],
  ["boron_b_chelated", "chelated boron"],
  ["humic_acid", "humic acid"],
  ["falvic_acid", "fulvic acid"],
  ["organic_carbon", "organic carbon"],
  ["beneficial_microbial_load", "microbial load"],
  ["ph", "pH"],
  ["c_n_ratio", "C:N ratio"],
  ["moisture_content", "moisture"],
  ["shelf_life", "shelf life"],
];

/** Properties describing the physical product rather than its analysis. */
const DESCRIPTION_FIELDS = ["appearance", "solubility", "particle_size", "chelating_agent"];

type GraphProduct = {
  name: string;
  props: Record<string, string>;
  deficiencies: string[];
  crops: string[];
  availableSize: string | null;
};

/**
 * Makes a graph value speakable, because everything written here is read out
 * by Sarvam's TTS on a live call rather than printed on a spec sheet.
 *
 * Every rewrite below is faithful to the value, never a change to what it
 * says: en dashes and non-breaking spaces out (a dash becomes an abrupt break
 * when spoken, the same reason voice-output.ts strips them from the model's
 * own text), superscript powers expanded, comparison symbols turned into the
 * words a person would actually say.
 */
function clean(value: string): string {
  return value
    .replace(/[‐-―]/g, "-")
    .replace(/ /g, " ")
    // A superscript digit is silent or garbled in TTS. The expansion is
    // exact arithmetic on the value, never a claim about it: 10⁶ is 1000000.
    .replace(/10([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (whole: string, sup: string) => {
      const exponent = Number([...sup].map((c) => "⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(c)).join(""));
      // Only expand what stays a readable whole number; anything larger
      // keeps its digits rather than becoming a wall of zeroes.
      return exponent <= 9 ? String(10 ** exponent) : whole;
    })
    // A bare comparison symbol is not a word, and a C-to-N ratio written
    // with "<" has to be sayable on a phone call.
    .replace(/≥\s*/g, "at least ")
    .replace(/≤\s*/g, "up to ")
    .replace(/>\s*/g, "over ")
    .replace(/<\s*/g, "under ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNutrientContent(props: Record<string, string>): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [prop, label] of NUTRIENT_FIELDS) {
    const raw = props[prop];
    // phosphorus_p2o5 and total_phosphorus_p2o5 share a label and never both
    // appear on one node, but guard anyway so a future graph change cannot
    // produce "P2O5 ..., P2O5 ...".
    if (!raw || seen.has(label)) continue;
    seen.add(label);
    parts.push(`${label} ${clean(raw)}`);
  }
  return parts.length ? parts.join(", ") : null;
}

function buildDescription(product: GraphProduct): string | null {
  const bits = DESCRIPTION_FIELDS.map((f) => product.props[f])
    .filter(Boolean)
    .map(clean)
    // No trailing full stop: catalogueFacts() joins description and the
    // agronomy fields with ". ", so one here produces "...Liquid.. helps with".
    .map((bit) => bit.replace(/\.$/, ""));
  return bits.length ? bits.join(". ") : null;
}

async function fetchGraphProducts(driver: Driver): Promise<Map<string, GraphProduct>> {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
      `MATCH (p:Product) WHERE p.id IN $ids
       OPTIONAL MATCH (p)-[:TREATS_DEFICIENCY]->(d:Deficiency)
       OPTIONAL MATCH (p)-[:SUITABLE_FOR]->(c:Crop)
       RETURN p.id AS id, p.name AS name, properties(p) AS props,
              collect(DISTINCT d.name) AS deficiencies,
              collect(DISTINCT c.name) AS crops`,
      { ids: Object.values(SKU_TO_GRAPH_ID) },
    );

    const out = new Map<string, GraphProduct>();
    for (const record of result.records) {
      const props = record.get("props") as Record<string, string>;
      out.set(record.get("id") as string, {
        name: record.get("name") as string,
        props,
        deficiencies: (record.get("deficiencies") as string[]).filter(Boolean).sort(),
        crops: (record.get("crops") as string[]).filter(Boolean).sort(),
        availableSize: props.available_size ? clean(props.available_size) : null,
      });
    }
    return out;
  } finally {
    await session.close();
  }
}

function show(value: string | null): string {
  return value == null || value === "" ? "(empty)" : value;
}

/**
 * Compares the CRM's "25 kg" against the graph's "5 kg", ignoring spacing,
 * case and British spelling, so only a genuine disagreement is reported. The
 * two catalogues really do differ on the vermicompost and FYM pack; they also
 * write the same 1-litre pack as "liter" and "Litre", and crying wolf on that
 * would bury the real one.
 */
function sameSize(crmPackSize: string, crmUnit: string, graphSize: string): boolean {
  const strip = (s: string) =>
    s.toLowerCase().replace(/litre/g, "liter").replace(/[^a-z0-9]/g, "");
  return strip(`${crmPackSize}${crmUnit}`) === strip(graphSize);
}

async function main() {
  const apply = process.argv.includes("--apply");

  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error("NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD must all be set in .env");
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const graph = await fetchGraphProducts(driver);
    const skus = Object.keys(SKU_TO_GRAPH_ID);
    const products = await prisma.product.findMany({
      where: { sku: { in: skus } },
      select: {
        sku: true,
        name: true,
        packSize: true,
        unit: true,
        description: true,
        nutrientContent: true,
        problemSolved: true,
        targetCrops: true,
        dosage: true,
        applicationMethod: true,
      },
      orderBy: { sku: "asc" },
    });

    const missing = skus.filter((sku) => !products.some((p) => p.sku === sku));
    if (missing.length) console.warn(`! not present in the CRM, skipped: ${missing.join(", ")}`);

    let changed = 0;
    for (const product of products) {
      const node = graph.get(SKU_TO_GRAPH_ID[product.sku]!);
      console.log(`\n=== ${product.sku}  ${product.name}`);
      if (!node) {
        console.warn("  ! no matching node in the knowledge graph — skipped");
        continue;
      }

      const proposed = {
        nutrientContent: buildNutrientContent(node.props),
        problemSolved: node.deficiencies.length ? node.deficiencies.join(", ") : null,
        description: buildDescription(node),
      };

      const data: Record<string, string> = {};
      for (const [field, value] of Object.entries(proposed) as [
        keyof typeof proposed,
        string | null,
      ][]) {
        const current = product[field];
        if (value == null) {
          console.log(`  ${field.padEnd(16)} ${show(current)}   (graph has nothing — left alone)`);
        } else if (current === value) {
          console.log(`  ${field.padEnd(16)} unchanged`);
        } else {
          console.log(`  ${field.padEnd(16)} ${show(current)}`);
          console.log(`  ${"".padEnd(16)}   -> ${value}`);
          data[field] = value;
        }
      }

      // Reported, never written. The CRM calls this vermicompost a 25 kg pack
      // where the graph says 5 kg, and which is right is a business question —
      // pack size reaches quotations and invoices, so guessing is worse than
      // leaving it alone.
      if (node.availableSize && product.packSize) {
        if (!sameSize(product.packSize, product.unit, node.availableSize)) {
          console.warn(
            `  ! pack size differs: CRM "${product.packSize} ${product.unit}" vs graph "${node.availableSize}" — not changed`,
          );
        }
      }

      // targetCrops is deliberately not written. The graph links 14 to 40
      // crops to each of these, and a flat list that long makes every product
      // look right for every crop, which is exactly what stops the agent
      // choosing between them. Per-lead crop matching already happens live in
      // voice-agent/lib/graph-facts.ts. Printed so a human can paste a short
      // marketing list into /products if they want one.
      if (!product.targetCrops) {
        console.log(
          `  ${"targetCrops".padEnd(16)} (empty) — graph links ${node.crops.length} crops, e.g. ${node.crops.slice(0, 8).join(", ")}`,
        );
      }
      for (const field of ["dosage", "applicationMethod"] as const) {
        if (!product[field]) {
          console.log(`  ${field.padEnd(16)} (empty) — not in the graph, needs an agronomist`);
        }
      }

      if (Object.keys(data).length === 0) continue;
      changed++;
      if (apply) {
        await prisma.product.update({ where: { sku: product.sku }, data });
        console.log("  written");
      }
    }

    console.log(
      `\n${changed} product(s) with changes.` +
        (apply ? " Applied." : " Dry run — re-run with --apply to write."),
    );
  } finally {
    await prisma.$disconnect();
    await driver.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
