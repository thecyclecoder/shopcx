/**
 * One-time (idempotent) migration: pull every Shopify-hosted product, variant,
 * and free-gift image onto our own Supabase storage and rewrite the DB
 * references, so nothing breaks when Shopify is sunset.
 *
 *   npx tsx scripts/migrate-shopify-images.ts          # dry run (counts only)
 *   npx tsx scripts/migrate-shopify-images.ts --commit # actually migrate
 *
 * Covers: products.image_url, products.variants (jsonb), product_variants.image_url,
 * product_variants.isolated_image_url, pricing_rules.free_gift_image_url.
 * A shared cache migrates an identical image once. Re-running is safe (the
 * object path is a hash of the source URL; non-Shopify URLs are skipped).
 */
import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath, "utf8").split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq < 0) continue; const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1); }

const COMMIT = process.argv.includes("--commit");

(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { migrateShopifyImage, migrateImagesInJson, isShopifyImage } = await import("../src/lib/product-image-migrate");
  const admin = createAdminClient();
  const cache = new Map<string, string>(); // source URL → migrated URL (shared)
  let urls = 0, rowsTouched = 0, failures = 0;

  async function mig(ws: string, url: string | null): Promise<string | null> {
    if (!isShopifyImage(url)) return null;
    if (cache.has(url!)) { urls++; return cache.get(url!)!; }
    if (!COMMIT) { urls++; return "DRY"; }
    const m = await migrateShopifyImage(ws, url!);
    if (!m) { failures++; return null; }
    cache.set(url!, m); urls++; return m;
  }

  console.log(COMMIT ? "=== COMMIT: migrating ===" : "=== DRY RUN (pass --commit to apply) ===");

  // 1) products: image_url + variants jsonb
  const { data: products } = await admin.from("products").select("id, workspace_id, image_url, variants");
  for (const p of products || []) {
    const ws = p.workspace_id as string;
    const update: Record<string, unknown> = {};
    const newImg = await mig(ws, p.image_url as string | null);
    if (newImg && newImg !== "DRY") update.image_url = newImg;
    else if (newImg === "DRY") update.image_url = "<dry>";
    if (p.variants) {
      const { value, migrated } = COMMIT
        ? await migrateImagesInJson(ws, p.variants, cache)
        : { value: p.variants, migrated: countShopify(p.variants) };
      if (migrated > 0) { urls += COMMIT ? 0 : migrated; if (COMMIT) update.variants = value; else update.variants = "<dry>"; }
    }
    if (Object.keys(update).length) {
      rowsTouched++;
      if (COMMIT) { delete (update as Record<string, unknown>)["<dry>"]; const clean = Object.fromEntries(Object.entries(update).filter(([, v]) => v !== "<dry>")); if (Object.keys(clean).length) { clean.updated_at = new Date().toISOString(); await admin.from("products").update(clean).eq("id", p.id); } }
    }
  }

  // 2) product_variants: image_url + isolated_image_url
  const { data: variants } = await admin.from("product_variants").select("id, workspace_id, image_url, isolated_image_url");
  for (const v of variants || []) {
    const ws = v.workspace_id as string;
    const clean: Record<string, unknown> = {};
    const a = await mig(ws, v.image_url as string | null);
    if (COMMIT && a) clean.image_url = a;
    const b = await mig(ws, v.isolated_image_url as string | null);
    if (COMMIT && b) clean.isolated_image_url = b;
    if ((isShopifyImage(v.image_url) || isShopifyImage(v.isolated_image_url))) {
      rowsTouched++;
      if (COMMIT && Object.keys(clean).length) { clean.updated_at = new Date().toISOString(); await admin.from("product_variants").update(clean).eq("id", v.id); }
    }
  }

  // 3) pricing_rules: free_gift_image_url
  const { data: rules } = await admin.from("pricing_rules").select("id, workspace_id, free_gift_image_url");
  for (const r of rules || []) {
    if (!isShopifyImage(r.free_gift_image_url)) continue;
    const ws = r.workspace_id as string;
    const m = await mig(ws, r.free_gift_image_url as string);
    rowsTouched++;
    if (COMMIT && m) await admin.from("pricing_rules").update({ free_gift_image_url: m, updated_at: new Date().toISOString() }).eq("id", r.id);
  }

  console.log(`\nShopify image URLs ${COMMIT ? "migrated" : "found"}: ${urls} | rows ${COMMIT ? "updated" : "to update"}: ${rowsTouched} | unique images: ${cache.size || urls} | failures: ${failures}`);

  if (COMMIT) {
    // Verify nothing Shopify-hosted remains in the migrated columns.
    const { Client } = await import("pg");
    const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/^https:\/\//, "").split(".")[0];
    const c = new Client({ host: "aws-1-us-east-1.pooler.supabase.com", port: 6543, user: `postgres.${ref}`, password: process.env.SUPABASE_DB_PASSWORD, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    for (const [t, col] of [["products", "image_url"], ["products", "variants"], ["product_variants", "image_url"], ["product_variants", "isolated_image_url"], ["pricing_rules", "free_gift_image_url"]] as const) {
      const n = (await c.query(`select count(*)::int n from public.${t} where ${col}::text ~* 'cdn\\.shopify\\.com|\\.myshopify\\.com'`)).rows[0].n;
      console.log(`  remaining shopify in ${t}.${col}: ${n}`);
    }
    await c.end();
  }
})().catch(e => { console.error(e); process.exit(1); });

function countShopify(v: unknown): number {
  let n = 0;
  const walk = (x: unknown) => {
    if (typeof x === "string") { if (/cdn\.shopify\.com|\.myshopify\.com/i.test(x)) n++; }
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(v);
  return n;
}
