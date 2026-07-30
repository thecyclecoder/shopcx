import "./_bootstrap";
import { writeFileSync, mkdirSync } from "fs";
const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OUT = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/157c5e1d-b40b-4bb8-838d-10303624a6a8/scratchpad/theme";

const FILES = [
  "snippets/superfood-tabs-benefits.liquid",
  "snippets/amazing-coffee-benefits.liquid",
  "snippets/product-media-gallery.liquid",
  "templates/product.superfood-tabs.json",
  "templates/product.amazing-creamer.json",
  "templates/product.creatine-prime.json",
  "templates/product.amazing-coffee.json",
];

async function main() {
  const { getLiveTheme, readThemeFile, listRepoFiles } = await import("../src/lib/shopify-theme");
  const live = await getLiveTheme(WS);
  const target = live.target;
  mkdirSync(OUT, { recursive: true });

  // find any ashwavana templates
  const tree = await listRepoFiles(target);
  const ashwa = Array.from(tree.keys()).filter((p) => /product\..*(ashwa|guru|zen|relax|focus)/i.test(p));
  console.log("ashwavana product templates found:", ashwa);

  const all = [...FILES, ...ashwa];
  for (const f of all) {
    const content = await readThemeFile(target, f);
    if (content == null) { console.log(`MISSING: ${f}`); continue; }
    const safe = f.replace(/\//g, "__");
    writeFileSync(`${OUT}/${safe}`, content);
    console.log(`wrote ${safe} (${content.split("\n").length} lines)`);
  }
  // also list all product.* templates so we can see what handles exist
  console.log("\nall product templates:");
  for (const p of Array.from(tree.keys()).filter((p) => /^templates\/product\./.test(p)).sort()) console.log("  " + p);
}
main().catch((e) => { console.error(e); process.exit(1); });
