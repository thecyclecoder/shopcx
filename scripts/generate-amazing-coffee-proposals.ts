/**
 * Phase 2 live check: generate demographic-driven avatar proposals for Amazing
 * Coffee and assert the four-field-tuple contract (no health_priorities/buyer_type).
 *
 *   npx tsx scripts/generate-amazing-coffee-proposals.ts
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
  const { generateAvatarProposals } = await import("../src/lib/ad-avatar-proposals");
  const res = await generateAvatarProposals(PRODUCT_ID);
  console.log(`ok=${res.ok} proposals=${res.proposals.length} ${res.reason ? "reason=" + res.reason : ""}`);

  let cleanBasis = true;
  for (const p of res.proposals) {
    const basisKeys = Object.keys(p.demographic_basis);
    const forbidden = basisKeys.filter((k) => /health_priorities|buyer_type|urban|owner_pct|college|versium/i.test(k));
    if (forbidden.length) cleanBasis = false;
    console.log(`  • ${p.archetype_brief.name} — cohort ${p.demographic_basis.cohort_size}, fallback=${p.demographic_basis.used_fallback_snapshot}`);
    console.log(`    setting: ${p.archetype_brief.setting}`);
  }
  console.log(`\ndemographic_basis clean (no health_priorities/buyer_type/geo): ${cleanBasis}`);
  const pass = res.ok && res.proposals.length >= 2 && cleanBasis;
  console.log(pass ? "✓ Phase 2 live criteria met" : "✗ criteria not fully met (may be sparse cohort — see reason)");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
