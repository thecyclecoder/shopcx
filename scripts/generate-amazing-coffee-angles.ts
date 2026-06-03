/**
 * Phase 0.5 live check: generate real ad angles for Amazing Coffee and assert
 * the anchoring + Meta-cap contract holds.
 *
 *   npx tsx scripts/generate-amazing-coffee-angles.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  const k = t.slice(0, i);
  if (!process.env[k]) process.env[k] = t.slice(i + 1);
}

const PRODUCT_ID = "ea433e56-0aa4-4b46-9107-feb11f77f533"; // Amazing Coffee

async function main() {
  // Dynamic import AFTER env is loaded — the lib captures ANTHROPIC_API_KEY at module load.
  const { loadAngleInputs, generateAngles } = await import("../src/lib/ad-angles");
  const inputs = await loadAngleInputs(PRODUCT_ID);
  const validAnchors = new Set<string>([
    ...inputs.benefit_bar.map((b) => b.text.toLowerCase().trim()),
    ...inputs.lead_benefits.map((b) => b.name.toLowerCase().trim()),
  ]);
  console.log(`benefit_bar chips: ${inputs.benefit_bar.length}, lead benefits: ${inputs.lead_benefits.length}, valid anchors: ${validAnchors.size}`);

  const res = await generateAngles(PRODUCT_ID, 12);
  console.log(`\ngenerate: ok=${res.ok} inserted=${res.inserted.length} rejected=${res.rejected.length} ${res.reason ? "reason=" + res.reason : ""}`);
  if (res.rejected.length) console.log("sample rejections:", res.rejected.slice(0, 3).map((r) => r.reasons[0]));

  let anchored = 0;
  let metaOk = 0;
  for (const a of res.inserted) {
    if (validAnchors.has(a.lead_benefit_anchor.toLowerCase().trim())) anchored++;
    if (a.meta_headline.length <= 40 && a.meta_primary_text.length <= 125 && a.meta_description.length <= 30) metaOk++;
  }
  console.log(`anchored: ${anchored}/${res.inserted.length}`);
  console.log(`meta caps respected: ${metaOk}/${res.inserted.length}`);
  console.log("\nsample angles:");
  for (const a of res.inserted.slice(0, 4)) {
    console.log(`  [${a.hook_slug} · LF8 ${a.lf8_slot}] anchor="${a.lead_benefit_anchor}"  hook="${a.hook_one_liner}"`);
  }

  const pass = res.ok && res.inserted.length >= 12 && anchored === res.inserted.length && metaOk === res.inserted.length;
  console.log(pass ? "\n✓ Phase 0.5 live criteria met" : "\n✗ criteria not fully met");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
