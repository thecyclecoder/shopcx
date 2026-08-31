/** Why does the cold filter reject THIS competitor ad? Full row + the exact predicate result. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { competitorFocalIsWarmHot, competitorFocalIsCold, competitorTemperatureFit } from "../src/lib/ads/creative-sourcing";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ID = process.argv[2] ?? "e2661bca-51b7-4796-8b50-a68e3d074b9e";

async function main() {
  const a = createAdminClient();
  const { data: s, error } = await a.from("creative_skeletons").select("*").eq("workspace_id", WS).eq("id", ID).maybeSingle();
  if (error) throw new Error(`creative_skeletons: ${error.message}`);
  if (!s) { console.log("skeleton not found"); return; }

  console.log("=== SKELETON ===");
  for (const k of ["advertiser", "title", "days_running", "first_seen", "last_seen", "status", "media_type", "format", "framework", "do_not_use", "seed_keyword", "product_id"]) {
    if (s[k] !== null && s[k] !== undefined) console.log(`  ${k.padEnd(18)} ${String(s[k]).slice(0, 110)}`);
  }
  console.log("\n=== THE FOUR SUBSTANCE SLOTS ===");
  for (const k of ["hook", "mechanism_claim", "proof", "offer"]) {
    console.log(`  ${k.padEnd(18)} ${s[k] === null ? "(null)" : `"${String(s[k])}"`}`);
  }
  console.log(`\n  concept_tags: ${JSON.stringify(s.concept_tags ?? null)}`);

  const pick = { offer: (s.offer as string | null) ?? null, conceptTags: (s.concept_tags ?? null) as never };
  console.log("\n=== FILTER VERDICTS ===");
  console.log(`  competitorFocalIsWarmHot : ${competitorFocalIsWarmHot(pick)}`);
  console.log(`  competitorFocalIsCold    : ${competitorFocalIsCold(pick)}`);
  console.log(`  temperatureFit(cold)     : ${competitorTemperatureFit(pick, "cold")}`);
  console.log(`  temperatureFit(warm)     : ${competitorTemperatureFit(pick, "warm")}`);

  const hasOffer = !!(s.offer && String(s.offer).trim());
  console.log(`\n⇒ ${hasOffer
    ? `EXCLUDED from cold solely because \`offer\` is non-empty ("${String(s.offer).slice(0, 60)}") — creative-sourcing.ts:73`
    : "not excluded by the offer rule; check lever/archetype"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
