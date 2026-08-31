/**
 * Do K-Cups' 40 shared competitor angles SURVIVE the cold-temperature exclusion,
 * or does the pool empty and silently fall back to own-brand?
 * This is the suspected reason every K-Cups explore ad has competitor_hook=null. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getProvenCompetitorAngles } from "../src/lib/ads/creative-sourcing";
import { selectAnglesForTemperature, type ScoredAngle } from "../src/lib/ads/creative-brief";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";

function toScored(c: Record<string, unknown>): ScoredAngle {
  return {
    hook: String(c.hook ?? ""),
    source: "competitor",
    leadBenefit: String(c.mechanismClaim ?? "proven competitor angle"),
    acquisitionPower: 9,
    retentionTruth: 5,
    commodity: false,
    hasRealPhoto: false,
    reasons: [],
    conceptTags: c.conceptTags,
    raw: { advertiser: c.advertiser, hook: c.hook, offer: c.offer, proof: c.proof, mechanismClaim: c.mechanismClaim },
  } as unknown as ScoredAngle;
}

async function main() {
  const a = createAdminClient();
  for (const [label, pid] of [["Amazing Coffee K-Cups", KCUPS], ["Amazing Coffee", COFFEE]] as const) {
    const res = await getProvenCompetitorAngles(a, WS, { productId: pid }) as { angles?: Array<Record<string, unknown>>; usedFallback?: boolean };
    const comp = (res.angles ?? []).filter((c) => c.hook).map(toScored);
    console.log(`\n════ ${label} ════`);
    console.log(`competitor angles available: ${comp.length}  (usedFallback=${res.usedFallback})`);

    for (const temp of ["cold", "warm", "hot"] as const) {
      const out = selectAnglesForTemperature(comp, [], temp) as ScoredAngle[];
      const survivingCompetitor = out.filter((x) => x.source === "competitor").length;
      console.log(`   ${temp.padEnd(5)} → ${String(out.length).padStart(3)} total, ${String(survivingCompetitor).padStart(3)} competitor survive` +
        (temp === "cold" && survivingCompetitor === 0 ? "   ← POOL EMPTIED → own-brand fallback" : ""));
    }

    const cold = (selectAnglesForTemperature(comp, [], "cold") as ScoredAngle[]).filter((x) => x.source === "competitor");
    console.log(`   surviving cold competitor hooks (first 5):`);
    for (const x of cold.slice(0, 5)) console.log(`      ${String(x.hook).slice(0, 90)}`);
    if (!cold.length) {
      console.log(`   examples of what was EXCLUDED (first 5):`);
      for (const x of comp.slice(0, 5)) console.log(`      ${String(x.hook).slice(0, 90)}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
