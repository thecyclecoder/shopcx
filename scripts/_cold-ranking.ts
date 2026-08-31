/**
 * The new COLD ranking for K-Cups: nothing deleted, discount-led ads ranked last.
 * Confirms the Erth Labs "Stopped Ozempic" 120d winner is usable again. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getProvenCompetitorAngles, offerIsHardDiscount, competitorFocalIsWarmHot, competitorFocalIsCold } from "../src/lib/ads/creative-sourcing";
import { selectAnglesForTemperature, type ScoredAngle } from "../src/lib/ads/creative-brief";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";

function toScored(c: Record<string, unknown>): ScoredAngle {
  return {
    hook: String(c.hook ?? ""), source: "competitor", leadBenefit: "", acquisitionPower: 9,
    retentionTruth: 5, commodity: false, hasRealPhoto: false, reasons: [],
    conceptTags: c.conceptTags as never,
    raw: { offer: c.offer, advertiser: c.advertiser, daysRunning: c.daysRunning },
  } as unknown as ScoredAngle;
}

function tier(a: ScoredAngle): string {
  const raw = (a.raw ?? {}) as { offer?: unknown };
  const offer = typeof raw.offer === "string" ? raw.offer : null;
  const ct = a.conceptTags ?? null;
  if (offerIsHardDiscount(offer)) return "3 discount";
  if (competitorFocalIsWarmHot({ offer, conceptTags: ct } as never)) return "2 warm-ish";
  if (competitorFocalIsCold({ conceptTags: ct } as never)) return "0 cold";
  return "1 neutral";
}

async function main() {
  const a = createAdminClient();
  const res = await getProvenCompetitorAngles(a, WS, { productId: KCUPS }) as { angles?: Array<Record<string, unknown>> };
  const comp = (res.angles ?? []).filter((c) => c.hook).map(toScored);
  const ranked = selectAnglesForTemperature(comp, [], "cold") as ScoredAngle[];

  console.log(`cold-ranked competitor angles for K-Cups: ${ranked.length} (was 1 under the hard filter)\n`);
  console.log(`tier        days  offer                            hook`);
  for (const x of ranked.slice(0, 16)) {
    const raw = (x.raw ?? {}) as Record<string, unknown>;
    const offer = String(raw.offer ?? "").slice(0, 30);
    console.log(`${tier(x).padEnd(11)} ${String(raw.daysRunning ?? "?").padStart(4)}  ${offer.padEnd(32)} ${String(x.hook).slice(0, 58)}`);
  }

  const ozempic = ranked.findIndex((x) => /ozempic/i.test(String(x.hook)));
  console.log(`\n"Stopped Ozempic, Kept Losing Weight" → ${ozempic === -1 ? "NOT PRESENT" : `rank #${ozempic + 1} of ${ranked.length} (usable)`}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
