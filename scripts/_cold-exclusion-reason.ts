/**
 * WHICH signal excludes 39 of 40 competitor angles on a cold run?
 * Splits the exclusion by cause so the fix targets the right line. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getProvenCompetitorAngles, competitorFocalIsWarmHot, competitorFocalIsCold, competitorTemperatureFit } from "../src/lib/ads/creative-sourcing";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";

async function main() {
  const a = createAdminClient();
  const res = await getProvenCompetitorAngles(a, WS, { productId: KCUPS }) as { angles?: Array<Record<string, unknown>> };
  const angles = (res.angles ?? []).filter((c) => c.hook);
  console.log(`competitor angles for K-Cups: ${angles.length}\n`);

  let byOffer = 0, byLever = 0, byText = 0, kept = 0;
  const fit = { match: 0, neutral: 0, mismatch: 0 } as Record<string, number>;

  for (const c of angles) {
    const offer = typeof c.offer === "string" ? c.offer : null;
    const ct = (c.conceptTags ?? null) as Record<string, unknown> | null;
    const pick = { offer, conceptTags: ct } as never;

    fit[competitorTemperatureFit(pick, "cold")] += 1;

    if (offer && offer.trim().length > 0) { byOffer += 1; continue; }
    const lever = String((ct?.cialdini_lever ?? "")).toLowerCase();
    if (lever === "social_proof" || lever === "scarcity") { byLever += 1; continue; }
    if (competitorFocalIsWarmHot(pick)) { byText += 1; continue; }
    kept += 1;
  }

  console.log(`EXCLUDED by a non-empty \`offer\` string : ${byOffer}`);
  console.log(`EXCLUDED by cialdini_lever social/scarcity: ${byLever}`);
  console.log(`EXCLUDED by archetype/angle text match    : ${byText}`);
  console.log(`KEPT for cold                             : ${kept}`);

  console.log(`\ncompetitorTemperatureFit(cold) — the PARTITION the design intends:`);
  console.log(`   match=${fit.match}  neutral=${fit.neutral}  mismatch=${fit.mismatch}`);
  console.log(`\n⇒ a partition would leave ${fit.match + fit.neutral + fit.mismatch} angles usable (mismatch ranked last);`);
  console.log(`  the hard filter leaves ${kept}.`);

  console.log(`\nsample \`offer\` values that triggered exclusion:`);
  let shown = 0;
  for (const c of angles) {
    const offer = typeof c.offer === "string" ? c.offer : null;
    if (!offer || !offer.trim() || shown >= 8) continue;
    shown += 1;
    console.log(`   ${String(c.advertiser ?? "?").slice(0, 18).padEnd(20)} offer="${offer.slice(0, 60)}"`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
