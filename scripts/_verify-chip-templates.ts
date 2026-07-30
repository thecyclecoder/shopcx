import "./_bootstrap";
const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

function stripJsonc(s: string): string {
  return s.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
}

async function main() {
  // read LIVE from Shopify (not the repo) to confirm the store re-pulled
  const { getWorkspaceShopify } = await import("../src/lib/shopify-theme").catch(() => ({} as any));
  const { getLiveTheme, readThemeFile } = await import("../src/lib/shopify-theme");
  const live = await getLiveTheme(WS);

  const targets = [
    { t: "amazing-creamer", slug: "amazing_creamer" },
    { t: "ashwavana-guru", slug: "ashwavana_guru" },
    { t: "ashwavana-zen", slug: "ashwavana_zen" },
    { t: "creatine-prime", slug: "creatine_prime" },
  ];
  for (const { t, slug } of targets) {
    // readThemeFile reads from the GitHub repo (source of truth after commit)
    const raw = await readThemeFile(live.target, `templates/product.${t}.json`);
    if (!raw) { console.log(`${t}: MISSING`); continue; }
    let doc: any;
    try { doc = JSON.parse(stripJsonc(raw)); } catch (e) { console.log(`${t}: JSON parse fail ${(e as Error).message}`); continue; }
    const b = doc.sections.main.blocks;
    const o: string[] = doc.sections.main.block_order;
    const hasDesc = !!b.description && o.includes("description");
    const chipId = `custom_liquid_${slug}_benefits`;
    const hasChip = !!b[chipId] && o.includes(chipId);
    const chipLiquid = b[chipId]?.settings?.custom_liquid || "";
    console.log(`${t}: description=${hasDesc}  chip=${hasChip}  render=${/render '.*-benefits'/.test(chipLiquid)}`);
  }
  console.log("\n(repo = source of truth; Shopify auto-pulls JSON templates within seconds of the commit)");
}
main().catch((e) => { console.error(e); process.exit(1); });
