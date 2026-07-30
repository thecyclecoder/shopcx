/**
 * Expand Superfood Tabs benefit chips (gold standard: snippets/superfood-tabs-benefits.liquid)
 * to 4 more PDPs: Amazing Creamer, Ashwavana Guru Focus, Ashwavana Zen Relax, Creatine Prime+.
 *
 * Per product it:
 *   1. Authors snippets/<slug>-benefits.liquid (clone of the st- gold standard, product copy).
 *   2. Adds a desktop gate in snippets/product-media-gallery.liquid (product.id -> small-hide render).
 *   3. Adds a `description` block + a mobile benefit-chip custom_liquid block
 *      (medium-hide large-up-hide) to the product template JSON, mirroring
 *      templates/product.superfood-tabs.json block_order.
 *
 * Content (4 benefit statements + proof numbers) comes from ShopCX product intelligence —
 * filled into PRODUCTS below from the extraction agent's report. NO fabricated benefits.
 *
 *   npx tsx scripts/_apply-benefit-chips.ts            # dry run: writes snippets + patched files to scratchpad, prints plan
 *   npx tsx scripts/_apply-benefit-chips.ts --commit   # commits everything to theme master + verifyDeployed
 */
import "./_bootstrap";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COMMIT = process.argv.includes("--commit");
const OUT = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/157c5e1d-b40b-4bb8-838d-10303624a6a8/scratchpad/theme-out";

interface Benefit { icon: keyof typeof ICONS; text: string; }
interface ProductCfg {
  slug: string;          // snippet slug -> snippets/<slug>-benefits.liquid
  shopifyId: number;     // product.id used in the gallery gate
  template: string;      // templates/product.<template>.json
  name: string;          // display name for the foot line
  benefits: Benefit[];   // exactly 4, in yellow/green/pink/purple order
  proof: string;         // foot line inner HTML e.g. "Backed by <strong>40 clinical studies</strong> on <strong>1 ingredient</strong> in Creatine Prime+"
}

// Icon SVGs reused from the gold standard, keyed so each product can pick the same 4 in order.
const ICONS = {
  bolt:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  spark:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3z"/></svg>',
  leaf:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21C5 12 12 5 21 5c0 9-7 16-16 16z"/></svg>',
  heart:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21S4 15 4 9.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 8 3.5C20 15 12 21 12 21z"/></svg>',
} as const;

// Fixed 4-slot color theme, mirroring the gold standard order.
const CARD = ["st-card-yellow st-icon-orange", "st-card-green st-icon-green", "st-card-pink st-icon-pink", "st-card-purple st-icon-purple"];
function cardClass(i: number) { return CARD[i].split(" ")[0]; }
function iconClass(i: number) { return CARD[i].split(" ")[1]; }

// ---- Copy from ShopCX product_page_content.benefit_bar (first 4) + computed proof numbers
//      (product_ingredient_research citations / distinct researched ingredients). All real, cited. ----
const PRODUCTS: ProductCfg[] = [
  {
    slug: "amazing-creamer",
    shopifyId: 7467657887917,
    template: "amazing-creamer",
    name: "Amazing Creamer",
    benefits: [
      { icon: "bolt",  text: "Helps with appetite &amp; weight loss" },
      { icon: "spark", text: "Makes skin smoother &amp; hair thicker" },
      { icon: "leaf",  text: "Sharpens brain focus" },
      { icon: "heart", text: "Reduces joint pain" },
    ],
    proof: "Backed by <strong>28 clinical studies</strong> on <strong>3 superfoods</strong> in Amazing Creamer",
  },
  {
    slug: "ashwavana-guru",
    shopifyId: 7467662016685,
    template: "ashwavana-guru",
    name: "Ashwavana Guru Focus",
    benefits: [
      { icon: "bolt",  text: "Steady energy — no jitters, no crash" },
      { icon: "spark", text: "Sharper focus and mental clarity" },
      { icon: "leaf",  text: "Calm under stress, with healthy cortisol support" },
      { icon: "heart", text: "Brighter, more balanced mood" },
    ],
    proof: "Backed by <strong>20 clinical studies</strong> on <strong>13 superfoods</strong> in Ashwavana Guru Focus",
  },
  {
    slug: "ashwavana-zen",
    shopifyId: 7467668013229,
    template: "ashwavana-zen",
    name: "Ashwavana Zen Relax",
    benefits: [
      { icon: "bolt",  text: "Calms stress &amp; anxiety" },
      { icon: "spark", text: "Sharper, calmer focus" },
      // NOTE: Zen Relax is caffeine-free — no energy claim (caffeine/energy belongs to Guru Focus).
      // Overridden to alcohol-alternative language pending a product-intelligence benefit_bar fix.
      { icon: "leaf",  text: "A calming alcohol alternative" },
      { icon: "heart", text: "Restful, caffeine-free wind-down" },
    ],
    proof: "Backed by <strong>23 clinical studies</strong> on <strong>12 superfoods</strong> in Ashwavana Zen Relax",
  },
  {
    slug: "creatine-prime",
    shopifyId: 8238402896045,
    template: "creatine-prime",
    name: "Creatine Prime+",
    benefits: [
      { icon: "bolt",  text: "5g creatine for strength &amp; healthy aging" },
      { icon: "spark", text: "Sharper, steadier focus — body &amp; brain" },
      { icon: "leaf",  text: "Smooth, stimulant-free energy — no jitters" },
      { icon: "heart", text: "Mixes clean, no chalk or grit" },
    ],
    proof: "Backed by <strong>11 clinical studies</strong> on <strong>2 superfoods</strong> in Creatine Prime+",
  },
];

function renderSnippet(p: ProductCfg): string {
  const cards = p.benefits.map((b, i) => `    <div class="st-benefit-card ${cardClass(i)}">
      <span class="st-benefit-icon ${iconClass(i)}">
        ${ICONS[b.icon]}
      </span>
      <p class="st-benefit-text">${b.text}</p>
    </div>`).join("\n\n");

  // Style block is copied verbatim from the gold standard (only one benefits snippet renders per page).
  const gold = readFileSync("/private/tmp/claude-501/-Users-admin-Projects-shopcx/157c5e1d-b40b-4bb8-838d-10303624a6a8/scratchpad/theme/snippets__superfood-tabs-benefits.liquid", "utf8");
  const styleBlock = gold.slice(gold.indexOf("<style>"), gold.indexOf("</style>") + "</style>".length);

  return `{%- comment -%}
  ${p.name} benefit chips — product-specific (mirrors snippets/superfood-tabs-benefits.liquid, the gold standard).
  Copy sourced from ShopCX storefront PDP product intelligence.
  Rendered: desktop via snippets/product-media-gallery.liquid (small-hide, gated to product.id ${p.shopifyId});
  mobile via a Custom Liquid block in templates/product.${p.template}.json (medium-hide large-up-hide).
{%- endcomment -%}
<div class="st-benefits">
  <div class="st-benefits-grid">
${cards}
  </div>

  <div class="st-benefits-foot">
    <span class="st-foot-check">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <span>${p.proof}</span>
  </div>
</div>

${styleBlock}
`;
}

function patchGallery(gallery: string): string {
  // Insert new gates right before the closing </media-gallery>, after the existing Tabs gate.
  const anchor = "</media-gallery>";
  const gates = PRODUCTS.map((p) => `      {%- comment -%} ${p.name} (${p.shopifyId}) — product-specific benefit chips. {%- endcomment -%}
      {%- if product.id == ${p.shopifyId} -%}
      <div class="small-hide" style="text-align: center; margin: 15px 0 15px;">
      {% render '${p.slug}-benefits' %}
    </div>
      {%- endif -%}
`).join("");
  if (gallery.includes(`{% render '${PRODUCTS[0].slug}-benefits' %}`)) {
    throw new Error("gallery already patched — aborting to avoid double gates");
  }
  return gallery.replace(anchor, gates + anchor);
}

function patchTemplate(raw: string, p: ProductCfg): string {
  const doc = JSON.parse(raw);
  const main = doc.sections.main;
  const blocks = main.blocks as Record<string, any>;
  const order: string[] = main.block_order;

  const descId = "description";
  const chipId = `custom_liquid_${p.slug.replace(/-/g, "_")}_benefits`;

  if (blocks[chipId]) throw new Error(`${p.template}: chip block already exists`);

  if (!blocks[descId]) blocks[descId] = { type: "description", settings: {} };
  blocks[chipId] = { type: "custom_liquid", settings: { custom_liquid: `<div class="medium-hide large-up-hide">{% render '${p.slug}-benefits' %}</div>` } };

  // Rebuild order: ensure description then chip sit right after title.
  const cleaned = order.filter((id) => id !== descId && id !== chipId);
  const ti = cleaned.indexOf("title");
  const at = ti >= 0 ? ti + 1 : 0;
  cleaned.splice(at, 0, descId, chipId);
  main.block_order = cleaned;

  return JSON.stringify(doc);
}

async function main() {
  if (!PRODUCTS.length) { console.error("PRODUCTS is empty — fill benefit copy from the intelligence agent first."); process.exit(2); }
  mkdirSync(OUT, { recursive: true });
  const SP = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/157c5e1d-b40b-4bb8-838d-10303624a6a8/scratchpad/theme";

  const { getLiveTheme, readThemeFile, commitThemeFiles, verifyDeployed } = await import("../src/lib/shopify-theme");
  const live = await getLiveTheme(WS);
  const target = live.target;
  console.log(`repo: ${target.owner}/${target.repo}@${target.branch}`);

  type FileChange = { path: string; content: string };
  const changes: FileChange[] = [];

  // 1. snippets
  for (const p of PRODUCTS) {
    const content = renderSnippet(p);
    writeFileSync(`${OUT}/${p.slug}-benefits.liquid`, content);
    changes.push({ path: `snippets/${p.slug}-benefits.liquid`, content });
  }

  // 2. gallery (read LIVE to patch on top of current)
  const gallery = await readThemeFile(target, "snippets/product-media-gallery.liquid");
  if (!gallery) throw new Error("could not read product-media-gallery.liquid");
  const patchedGallery = patchGallery(gallery);
  writeFileSync(`${OUT}/product-media-gallery.liquid`, patchedGallery);
  changes.push({ path: "snippets/product-media-gallery.liquid", content: patchedGallery });

  // 3. templates
  for (const p of PRODUCTS) {
    const raw = await readThemeFile(target, `templates/product.${p.template}.json`);
    if (!raw) throw new Error(`could not read templates/product.${p.template}.json`);
    const patched = patchTemplate(raw, p);
    writeFileSync(`${OUT}/product.${p.template}.json`, patched);
    changes.push({ path: `templates/product.${p.template}.json`, content: patched });
  }

  console.log(`\nplanned ${changes.length} file changes:`);
  for (const c of changes) console.log("  " + c.path);

  if (!COMMIT) { console.log("\nDRY RUN — wrote patched files to " + OUT + ". Pass --commit to push."); return; }

  const msg = "PDP: add benefit chips + description block to Creamer, Ashwavana Guru/Zen, Creatine Prime\n\n" +
    "Mirrors the Superfood Tabs gold standard (snippets/superfood-tabs-benefits.liquid): 4 product-specific benefit chips\n" +
    "(desktop via product-media-gallery.liquid small-hide gate; mobile via a custom_liquid block), plus the missing\n" +
    "description block, in each product's main-product block_order. Chip copy sourced from ShopCX PDP product intelligence.";
  const commit = await commitThemeFiles(target, changes, msg);
  console.log(`committed -> ${commit.commitSha}`);
  console.log(commit.url);

  const expected = changes.map((c) => ({ path: c.path, content: c.content }));
  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const rows = await verifyDeployed(WS, expected);
    const ok = rows.filter((r) => r.ok).length;
    console.log(`verify ${attempt}/12 — ${ok}/${rows.length} match live`);
    if (rows.every((r) => r.ok)) { console.log("LIVE — benefit chips + description live on all 4 PDPs."); return; }
  }
  console.log("commit landed but Shopify hasn't re-pulled after ~60s.");
}
main().catch((e) => { console.error(e); process.exit(1); });
