import "./_bootstrap";
import { readFileSync } from "fs";
const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OUT = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/157c5e1d-b40b-4bb8-838d-10303624a6a8/scratchpad/theme-out";

async function main() {
  const { getLiveTheme, commitThemeFiles, verifyDeployed } = await import("../src/lib/shopify-theme");
  const live = await getLiveTheme(WS);
  const content = readFileSync(`${OUT}/ashwavana-zen-benefits.liquid`, "utf8");
  const changes = [{ path: "snippets/ashwavana-zen-benefits.liquid", content }];
  const msg = "PDP: Zen Relax benefit chip — replace energy claim with alcohol-alternative copy\n\n" +
    "Ashwavana Zen Relax is caffeine-free, so the 'Clean energy, no jitters' chip was wrong (that's Guru Focus). " +
    "Overridden to 'A calming alcohol alternative' pending a product-intelligence benefit_bar fix.";
  const commit = await commitThemeFiles(live.target, changes, msg);
  console.log(`committed -> ${commit.commitSha}`);
  console.log(commit.url);
  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const rows = await verifyDeployed(WS, changes.map((c) => ({ path: c.path, content: c.content })));
    console.log(`verify ${attempt}/12 — ${rows.filter((r) => r.ok).length}/${rows.length} match live`);
    if (rows.every((r) => r.ok)) { console.log("LIVE — Zen Relax chip updated."); return; }
  }
  console.log("commit landed; Shopify re-pull pending.");
}
main().catch((e) => { console.error(e); process.exit(1); });
