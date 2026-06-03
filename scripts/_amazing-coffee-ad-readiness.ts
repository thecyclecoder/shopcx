/**
 * Show every piece of info the ad tool would have for Amazing Coffee,
 * sourced from what actually exists in the live DB today.
 *
 *   npx tsx scripts/_amazing-coffee-ad-readiness.ts
 */
import { readFileSync } from "fs"; import { resolve } from "path";
import { Client } from "pg";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const password = process.env.SUPABASE_DB_PASSWORD!;
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();

  const p = (await c.query(`SELECT id, title, description, allergen_free, awards FROM products WHERE workspace_id=$1 AND title ILIKE '%amazing coffee%' AND title NOT ILIKE '%bundle%' ORDER BY title LIMIT 1`, [WS])).rows[0];
  if (!p) { console.log("No Amazing Coffee product found."); await c.end(); return; }

  console.log("═".repeat(70));
  console.log(`PRODUCT: ${p.title}`);
  console.log(`product_id: ${p.id}`);
  console.log("═".repeat(70));

  console.log("\n── Product description (truncated 400 char) ──");
  console.log((p.description || "(none)").slice(0, 400));

  console.log("\n── products.allergen_free ──");
  console.log(p.allergen_free || []);
  console.log("\n── products.awards ──");
  console.log(p.awards || []);

  // product_intelligence (production shape: title, content, source, labeled_urls)
  const pi = (await c.query(`SELECT title, content, source, labeled_urls FROM product_intelligence WHERE product_id=$1 LIMIT 1`, [p.id])).rows[0];
  console.log("\n── product_intelligence ──");
  if (pi) {
    console.log("title:", pi.title || "(none)");
    console.log("content (truncated 600):", (pi.content || "").slice(0, 600));
    console.log("source:", pi.source || "(none)");
    console.log("labeled_urls (first 400 char):", JSON.stringify(pi.labeled_urls || [], null, 2).slice(0, 400));
  } else console.log("(none)");

  // Ingredients
  const ings = (await c.query(`SELECT id, name, dosage_mg, dosage_display, display_order FROM product_ingredients WHERE product_id=$1 ORDER BY display_order`, [p.id])).rows;
  console.log(`\n── product_ingredients (${ings.length}) ──`);
  for (const i of ings) {
    console.log(`  • ${i.name}${i.dosage_display ? ` (${i.dosage_display})` : i.dosage_mg ? ` (${i.dosage_mg}mg)` : ""}`);
  }

  // Ingredient research (benefits + science)
  const research = (await c.query(`SELECT pi.name, pir.benefit_headline, pir.mechanism_explanation, pir.clinically_studied_benefits, pir.ai_confidence FROM product_ingredient_research pir JOIN product_ingredients pi ON pi.id = pir.ingredient_id WHERE pir.product_id=$1 ORDER BY pi.display_order, pir.benefit_headline LIMIT 12`, [p.id])).rows;
  console.log(`\n── product_ingredient_research (${research.length} entries, showing 12) ──`);
  for (const r of research) {
    console.log(`  • ${r.name}: "${r.benefit_headline}" (conf=${r.ai_confidence})`);
    if (r.clinically_studied_benefits?.length) console.log(`    clinical: ${r.clinically_studied_benefits.slice(0, 3).join("; ")}`);
  }

  // Ingredient images via product_media slots
  const slugify = (n: string) => "ingredient_" + n.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const slots = ings.map(i => slugify(i.name));
  const media = (await c.query(`SELECT slot, url FROM product_media WHERE product_id=$1 AND slot = ANY($2::text[])`, [p.id, slots])).rows;
  console.log(`\n── ingredient image readiness (product_media slot lookup) ──`);
  for (const i of ings) {
    const slot = slugify(i.name);
    const m = media.find((mm: any) => mm.slot === slot);
    console.log(`  ${m ? "✓" : "✗"} ${i.name.padEnd(40)} ${m ? "image uploaded" : "missing"}`);
  }

  // Hero / lifestyle media
  const heroMedia = (await c.query(`SELECT slot, url FROM product_media WHERE product_id=$1 AND slot NOT LIKE 'ingredient_%' ORDER BY slot LIMIT 20`, [p.id])).rows;
  console.log(`\n── other product_media slots (${heroMedia.length}, b-roll candidates) ──`);
  for (const m of heroMedia) console.log(`  ${m.slot}`);

  // Variants
  const variants = (await c.query(`SELECT id, title, shopify_variant_id, image_url FROM product_variants WHERE product_id=$1 ORDER BY title LIMIT 10`, [p.id])).rows;
  console.log(`\n── product_variants (${variants.length}) ──`);
  for (const v of variants) {
    console.log(`  • ${v.title}${v.image_url ? " (image: yes)" : " (image: NO)"}`);
  }
  console.log("Note: isolated_image_url and physical_dimensions columns will be ADDED in Phase 0.");

  // Reviews for proof anchors
  const reviewCols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='product_reviews' AND column_name IN ('rating','title','body','reviewer_name','smart_featured','summary')`)).rows.map((r: any) => r.column_name);
  console.log(`\n── product_reviews columns available: ${reviewCols.join(", ")} ──`);
  const rev = (await c.query(`SELECT rating, title, body, summary FROM product_reviews WHERE product_id=$1 AND rating >= 4 ORDER BY rating DESC, created_at DESC LIMIT 5`, [p.id])).rows;
  console.log(`(top 5 reviews — these feed the angle generator's proof_anchor)`);
  for (const r of rev) {
    const body = (r.summary || r.body || r.title || "").trim().slice(0, 180);
    console.log(`  ★${r.rating} "${body}"`);
  }

  // Demographic cohort (Phase 2 avatar driver) — the 4-field tuple
  console.log("\n── demographic cohort behind Amazing Coffee buyers ──");
  console.log("(using the cohort query pattern from lifecycles/demographic-enrichment)");

  const customerIds = (await c.query(`
    SELECT DISTINCT o.customer_id
    FROM orders o, jsonb_array_elements(o.line_items) li
    WHERE o.workspace_id = $1::uuid
      AND o.customer_id IS NOT NULL
      AND li->>'title' ILIKE '%amazing coffee%'
  `, [WS])).rows.map((r: any) => r.customer_id);
  console.log(`Unique customer_ids: ${customerIds.length.toLocaleString()}`);

  if (customerIds.length > 0) {
    const sample = customerIds.slice(0, Math.min(5000, customerIds.length));
    const demos = (await c.query(`
      SELECT inferred_gender, inferred_age_range, inferred_life_stage, zip_income_bracket
      FROM customer_demographics
      WHERE workspace_id = $1::uuid
        AND customer_id = ANY($2::uuid[])
        AND inferred_gender IS NOT NULL
        AND inferred_gender != 'unknown'
    `, [WS, sample])).rows;

    console.log(`Enriched (4-field tuple available): ${demos.length.toLocaleString()} of sample ${sample.length.toLocaleString()}`);

    const bucket = (arr: any[], k: string) => {
      const m = new Map<string, number>();
      for (const r of arr) { const v = r[k] || "(null)"; m.set(v, (m.get(v) || 0) + 1); }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, n]) => `${v}: ${(n/arr.length*100).toFixed(0)}%`);
    };
    console.log("Gender:        ", bucket(demos, "inferred_gender").join(" · "));
    console.log("Age range:     ", bucket(demos, "inferred_age_range").join(" · "));
    console.log("Life stage:    ", bucket(demos, "inferred_life_stage").join(" · "));
    console.log("Income bracket:", bucket(demos, "zip_income_bracket").join(" · "));

    // Top archetype
    const tup = new Map<string, number>();
    for (const r of demos) {
      const k = `${r.inferred_gender} · ${r.inferred_age_range} · ${r.inferred_life_stage} · ${r.zip_income_bracket || "unknown_income"}`;
      tup.set(k, (tup.get(k) || 0) + 1);
    }
    const top = [...tup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.log("\nTop 3 archetype tuples (avatar-proposal seeds):");
    for (const [k, n] of top) console.log(`  ${(n/demos.length*100).toFixed(0)}% — ${k}`);
  }

  // Brand-level proof points
  const ws = (await c.query(`SELECT social_brand_proof_points FROM workspaces WHERE id=$1`, [WS])).rows[0];
  console.log("\n── workspaces.social_brand_proof_points (brand-level) ──");
  console.log((ws?.social_brand_proof_points || "(none)").slice(0, 600));

  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
