/**
 * With the "explore must be competitor-sourced" rail, how many COLD explore ads can each product
 * actually produce today? Measures the real capacity, per product. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getProvenCompetitorAngles, competitorTemperatureFit } from "../src/lib/ads/creative-sourcing";
import { selectAnglesForTemperature, type ScoredAngle } from "../src/lib/ads/creative-brief";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

function toScored(c: Record<string, unknown>): ScoredAngle {
  return {
    hook: String(c.hook ?? ""), source: "competitor",
    leadBenefit: String(c.mechanismClaim ?? ""), acquisitionPower: 9, retentionTruth: 5,
    commodity: false, hasRealPhoto: false, reasons: [], conceptTags: c.conceptTags,
    raw: { offer: c.offer, advertiser: c.advertiser, hook: c.hook },
  } as unknown as ScoredAngle;
}

async function main() {
  const a = createAdminClient();
  const { data: prods, error } = await a.from("products").select("id,title,status").eq("workspace_id", WS);
  if (error) throw new Error(`products: ${error.message}`);

  console.log(`product                        angles  cold-survive  partitioned  verdict`);
  for (const p of prods ?? []) {
    if (String(p.status ?? "").toLowerCase() !== "active") continue;
    const res = await getProvenCompetitorAngles(a, WS, { productId: String(p.id) }) as { angles?: Array<Record<string, unknown>> };
    const comp = (res.angles ?? []).filter((c) => c.hook).map(toScored);
    if (!comp.length) continue;

    const cold = (selectAnglesForTemperature(comp, [], "cold") as ScoredAngle[]).filter((x) => x.source === "competitor");
    // What a PARTITION would leave usable (match + neutral first, mismatch to the tail — all usable).
    const fits = comp.map((x) => competitorTemperatureFit({ offer: (x.raw as Record<string, unknown>)?.offer as string ?? null, conceptTags: x.conceptTags ?? null } as never, "cold"));
    const usable = fits.length;
    const good = fits.filter((f) => f !== "mismatch").length;

    const verdict = cold.length === 0 ? "⛔ NO cold explore ads possible"
      : cold.length <= 2 ? "⚠️ nearly starved"
      : "ok";
    console.log(`   ${String(p.title).slice(0, 28).padEnd(30)} ${String(comp.length).padStart(5)}  ${String(cold.length).padStart(11)}  ${String(`${good}+${usable - good}`).padStart(11)}  ${verdict}`);
  }
  console.log(`\n"partitioned" = match/neutral + mismatch-to-tail — every angle stays usable, offer-heavy ones ranked last.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
