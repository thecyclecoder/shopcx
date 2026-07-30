import "./_bootstrap";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { getLiveTheme, readThemeFile, listRepoFiles } = await import("../src/lib/shopify-theme");
  const live = await getLiveTheme(WS);
  const target = live.target;
  console.log(`theme: ${live.name} (${live.id})`);
  console.log(`repo:  ${target.owner}/${target.repo}@${target.branch}`);

  const tree = await listRepoFiles(target);
  const paths = Array.from(tree.keys());
  const candidates = paths.filter((p) =>
    /quantity|volume|qty|pack|break|bundle|tier/i.test(p)
  );
  console.log(`\n=== candidate files (${candidates.length}) ===`);
  for (const p of candidates) console.log("  " + p);

  // Also grep all liquid snippets/sections for "quantity break"/"pack" markers
  console.log(`\n=== grepping liquid for quantity-break markers ===`);
  const liquids = paths.filter((p) => /\.liquid$/i.test(p) && (p.startsWith("snippets/") || p.startsWith("sections/")));
  for (const p of liquids) {
    const content = await readThemeFile(target, p);
    if (!content) continue;
    if (/quantity[\s_-]*break|volume[\s_-]*discount|\b\d+\s*[-\s]?pack\b|qty[\s_-]*break/i.test(content)) {
      console.log("  MATCH: " + p);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
