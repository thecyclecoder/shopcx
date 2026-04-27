#!/usr/bin/env npx tsx
/**
 * One-time backfill: promote products.variants JSONB → product_variants table.
 *
 * For each product:
 *   1. Read existing variants JSONB array
 *   2. Upsert each into product_variants (matched by shopify_variant_id when
 *      present) — preserves any UUIDs already assigned
 *   3. Stamp internal_id back into each JSONB element so legacy readers can
 *      pick up the UUID without code changes
 *
 * Idempotent — safe to re-run.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

import { createAdminClient } from "../src/lib/supabase/admin";

interface JsonVariant {
  id?: string;                 // shopify variant id
  internal_id?: string;        // our UUID (stamped after first run)
  sku?: string | null;
  title?: string | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  price_cents?: number | null;
  compare_at_price_cents?: number | null;
  image_url?: string | null;
  weight?: number | null;
  weight_unit?: string | null;
  inventory_quantity?: number | null;
  available?: boolean;
}

async function main() {
  const admin = createAdminClient();

  // Pull every product with variants — small dataset (16 products × few variants each)
  const { data: products, error } = await admin
    .from("products")
    .select("id, workspace_id, variants");
  if (error) throw error;

  let totalVariants = 0;
  let totalUpserts = 0;
  let totalStampedJsonb = 0;

  for (const p of products || []) {
    const variants = (p.variants as JsonVariant[] | null) || [];
    if (!variants.length) continue;

    const updatedJsonb: JsonVariant[] = [];
    for (let position = 0; position < variants.length; position++) {
      const v = variants[position];
      totalVariants++;

      // Upsert: match by shopify_variant_id if we have one, else create fresh
      let row: { id: string } | null = null;
      if (v.id) {
        const { data, error: upErr } = await admin
          .from("product_variants")
          .upsert(
            {
              workspace_id: p.workspace_id,
              product_id: p.id,
              shopify_variant_id: v.id,
              sku: v.sku ?? null,
              title: v.title ?? null,
              option1: v.option1 ?? null,
              option2: v.option2 ?? null,
              option3: v.option3 ?? null,
              price_cents: v.price_cents ?? 0,
              compare_at_price_cents: v.compare_at_price_cents ?? null,
              image_url: v.image_url ?? null,
              weight: v.weight ?? null,
              weight_unit: v.weight_unit ?? null,
              position,
              inventory_quantity: v.inventory_quantity ?? null,
              available: v.available ?? true,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "workspace_id,shopify_variant_id" },
          )
          .select("id")
          .single();
        if (upErr) console.error(`Upsert error for ${v.id}:`, upErr.message);
        row = data;
      } else if (v.internal_id) {
        // Already has a UUID — update the existing row by id
        const { data } = await admin
          .from("product_variants")
          .update({
            sku: v.sku ?? null,
            title: v.title ?? null,
            price_cents: v.price_cents ?? 0,
            position,
            updated_at: new Date().toISOString(),
          })
          .eq("id", v.internal_id)
          .select("id")
          .single();
        row = data;
      } else {
        // No shopify id, no existing UUID → fresh insert
        const { data } = await admin
          .from("product_variants")
          .insert({
            workspace_id: p.workspace_id,
            product_id: p.id,
            sku: v.sku ?? null,
            title: v.title ?? null,
            price_cents: v.price_cents ?? 0,
            position,
            available: v.available ?? true,
          })
          .select("id")
          .single();
        row = data;
      }

      if (row) {
        totalUpserts++;
        const stamped = { ...v, internal_id: row.id };
        if (stamped.internal_id !== v.internal_id) totalStampedJsonb++;
        updatedJsonb.push(stamped);
      } else {
        updatedJsonb.push(v);
      }
    }

    // Write the JSONB back with internal_id stamped on each element
    await admin.from("products").update({ variants: updatedJsonb }).eq("id", p.id);
  }

  console.log(`Backfill complete:`);
  console.log(`  Products processed: ${(products || []).length}`);
  console.log(`  Variants seen:      ${totalVariants}`);
  console.log(`  Variants upserted:  ${totalUpserts}`);
  console.log(`  JSONB stamped:      ${totalStampedJsonb}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
