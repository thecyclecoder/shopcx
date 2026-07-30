// Read-only audit: fetch every active mapped ASIN's live listing copy and scan
// title/bullets/description for prohibited dietary-supplement claim language
// (the class Amazon flags as disease/treatment/detox claims).
import { createAdminClient } from "./_bootstrap";
import { spApiRequest } from "../src/lib/amazon/auth";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MKT = "ATVPDKIKX0DER";

// severity: HIGH = clear disease/detox/toxin; MED = weight/bloat/skin; LOW = borderline structure-function
const PATTERNS: { re: RegExp; sev: "HIGH" | "MED" | "LOW"; note: string }[] = [
  { re: /\bdetox(ify|ification|ing|ed)?\b/i, sev: "HIGH", note: "detox → implies toxin removal" },
  { re: /\bcleanse[sd]?\b|\bcleansing\b/i, sev: "HIGH", note: "cleanse → implies toxin removal" },
  { re: /\btoxins?\b/i, sev: "HIGH", note: "toxin claim" },
  { re: /\bflush(es|ing|ed)?\s+out\b|\bflush\s+(harmful|toxin)/i, sev: "HIGH", note: "flush out" },
  { re: /\bpurif(y|ies|ying|ication)\b/i, sev: "HIGH", note: "purify" },
  { re: /\bcures?\b|\bcuring\b/i, sev: "HIGH", note: "cure" },
  { re: /\btreats?\b|\btreating\b|\btreatment\b/i, sev: "HIGH", note: "treat (unless in the FDA disclaimer)" },
  { re: /\bheals?\b|\bhealing\b/i, sev: "HIGH", note: "heal" },
  { re: /\bprevents?\b|\bpreventing\b/i, sev: "HIGH", note: "prevent (unless in the FDA disclaimer)" },
  { re: /\banti[-\s]?inflammat/i, sev: "HIGH", note: "anti-inflammatory = disease claim" },
  { re: /\blowers?\b.*\b(blood pressure|cholesterol|blood sugar|glucose)\b/i, sev: "HIGH", note: "lowers a clinical marker" },
  { re: /\b(diabetes|hypertension|arthritis|cancer|depression|anxiety|insomnia|ibs|acid reflux|constipation)\b/i, sev: "HIGH", note: "named disease/condition" },
  { re: /\banti[-\s]?(bacterial|viral|biotic|fungal)\b/i, sev: "HIGH", note: "anti-microbial disease claim" },

  { re: /\bweight[-\s]?loss\b|\blose\s+weight\b|\bloses?\s+weight\b/i, sev: "MED", note: "weight loss" },
  { re: /\b(burn|burning|burns)\s+(fat|calories)\b|\bfat[-\s]?burn/i, sev: "MED", note: "fat burn" },
  { re: /\bboost(s|ing)?\s+(your\s+)?metabolism\b|\bmetabolism\s+boost/i, sev: "MED", note: "boost metabolism" },
  { re: /\bappetite\s+suppress|\bsuppress(es|ing)?\s+appetite\b/i, sev: "MED", note: "appetite suppressant" },
  { re: /\bslim(ming|mer)?\b|\bskinny\b/i, sev: "MED", note: "slimming / skinny" },
  { re: /\banti[-\s]?bloat|\breduce[sd]?\s+bloat|\bbloat(ing)?\s+relief|\bde[-\s]?bloat/i, sev: "MED", note: "bloating relief = digestive treatment" },
  { re: /\bclear(er)?\s+skin\b|\bacne\b|\bblemish/i, sev: "MED", note: "skin condition" },
  { re: /\bboost(s|ing)?\s+(your\s+)?immun|\bimmune\s+(support|boost)|\bimmunity\b/i, sev: "MED", note: "immune claim (Amazon scrutinizes)" },
  { re: /\breliev(e|es|ing|ed)\b|\brelief\b/i, sev: "MED", note: "relieve/relief (context-check)" },

  { re: /\bantioxidant/i, sev: "LOW", note: "antioxidant (usually OK, note context)" },
  { re: /\benerg(y|ize|izing)\b/i, sev: "LOW", note: "energy (structure-function, usually OK)" },
  { re: /\bgut\s+health\b|\bdigestive\s+health\b/i, sev: "LOW", note: "digestive/gut health (OK if not paired w/ treatment verb)" },
];

const FDA_DISCLAIMER = /not\s+intended\s+to\s+diagnose[,\s]+treat[,\s]+cure[,\s]+or\s+prevent/i;

function scanField(field: string, text: string) {
  const hits: { sev: string; note: string; snippet: string }[] = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    // Skip treat/prevent/cure matches that are part of the FDA disclaimer sentence
    if ((p.note.includes("FDA disclaimer")) && FDA_DISCLAIMER.test(text)) {
      // only skip if the specific hit is within the disclaimer clause
      const around = text.slice(Math.max(0, m.index - 40), m.index + 40);
      if (FDA_DISCLAIMER.test(around) || /diagnose/i.test(around)) continue;
    }
    const start = Math.max(0, m.index - 25);
    const snippet = text.slice(start, m.index + m[0].length + 25).replace(/\s+/g, " ").trim();
    hits.push({ sev: p.sev, note: p.note, snippet: `…${snippet}…` });
  }
  return hits.map((h) => ({ ...h, field }));
}

async function fetchListing(connId: string, sellerId: string, sku: string) {
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(
    sku,
  )}?marketplaceIds=${MKT}&includedData=attributes`;
  const res = await spApiRequest(connId, MKT, "GET", path);
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 120)}` };
  return res.json();
}

async function main() {
  const admin = createAdminClient();
  const { data: conns } = await admin
    .from("amazon_connections")
    .select("id, seller_id")
    .eq("workspace_id", WORKSPACE_ID);
  const connMap = new Map((conns || []).map((c) => [c.id, c.seller_id]));

  const { data: asins } = await admin
    .from("amazon_asins")
    .select("asin, sku, status, amazon_connection_id")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("status", "Active")
    .not("sku", "is", null);

  const report: any[] = [];
  for (const a of asins || []) {
    const sellerId = connMap.get(a.amazon_connection_id);
    if (!sellerId) continue;
    const listing = await fetchListing(a.amazon_connection_id, sellerId as string, a.sku as string);
    if (listing.error) {
      report.push({ asin: a.asin, sku: a.sku, error: listing.error });
      continue;
    }
    const attrs = listing.attributes || {};
    const title = attrs.item_name?.[0]?.value || "";
    const bullets: string[] = (attrs.bullet_point || []).map((b: any) => b.value || "");
    const desc = attrs.product_description?.[0]?.value || "";

    let hits = scanField("TITLE", title);
    bullets.forEach((b, i) => (hits = hits.concat(scanField(`BULLET ${i + 1}`, b))));
    hits = hits.concat(scanField("DESCRIPTION", desc));

    // de-dupe identical (field, note)
    const seen = new Set<string>();
    hits = hits.filter((h) => {
      const k = `${h.field}|${h.note}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    report.push({ asin: a.asin, sku: a.sku, title: title.slice(0, 90), hits });
  }

  // Print grouped
  for (const r of report) {
    if (r.error) {
      console.log(`\n■ ${r.asin} (${r.sku})  READ ERROR: ${r.error}`);
      continue;
    }
    const high = r.hits.filter((h: any) => h.sev === "HIGH").length;
    const med = r.hits.filter((h: any) => h.sev === "MED").length;
    const flag = high ? "🔴" : med ? "🟠" : r.hits.length ? "🟡" : "✅";
    console.log(`\n${flag} ${r.asin} (${r.sku})  HIGH=${high} MED=${med} LOW=${r.hits.length - high - med}`);
    console.log(`   ${r.title}`);
    for (const h of r.hits.sort((a: any, b: any) => (a.sev < b.sev ? -1 : 1))) {
      console.log(`   [${h.sev}] ${h.field}: ${h.note}  ${h.snippet}`);
    }
  }

  const clean = report.filter((r) => !r.error && !r.hits.length).length;
  const flagged = report.filter((r) => !r.error && r.hits.length).length;
  console.log(`\n=== ${flagged} flagged, ${clean} clean, ${report.filter((r) => r.error).length} errors of ${report.length} active listings ===`);
}

main().then(() => process.exit(0));
