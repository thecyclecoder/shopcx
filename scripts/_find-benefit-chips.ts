import "./_bootstrap";
import { writeFileSync, mkdirSync } from "fs";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OUT = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/157c5e1d-b40b-4bb8-838d-10303624a6a8/scratchpad/theme";

async function main() {
  const { getLiveTheme, readThemeFile, listRepoFiles } = await import("../src/lib/shopify-theme");
  const live = await getLiveTheme(WS);
  const target = live.target;
  console.log(`repo: ${target.owner}/${target.repo}@${target.branch}`);
  mkdirSync(OUT, { recursive: true });

  const tree = await listRepoFiles(target);
  const paths = Array.from(tree.keys()).filter((p) => /\.(liquid|json)$/i.test(p));

  const KW = /benefit|chip|\bicon-card\b|pill|clinical studies|superfoods in|value[-_ ]?prop/i;
  const hits: { path: string; lines: { n: number; text: string }[] }[] = [];
  for (const p of paths) {
    const content = await readThemeFile(target, p);
    if (!content) continue;
    const matched: { n: number; text: string }[] = [];
    content.split("\n").forEach((line, i) => {
      if (KW.test(line)) matched.push({ n: i + 1, text: line.trim().slice(0, 160) });
    });
    if (matched.length) hits.push({ path: p, lines: matched });
  }

  hits.sort((a, b) => b.lines.length - a.lines.length);
  for (const h of hits) {
    console.log(`\n=== ${h.path}  (${h.lines.length} hits) ===`);
    for (const l of h.lines.slice(0, 25)) console.log(`  ${l.n}: ${l.text}`);
    if (h.lines.length > 25) console.log(`  ... +${h.lines.length - 25} more`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
