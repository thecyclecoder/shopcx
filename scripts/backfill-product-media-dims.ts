/**
 * Backfill width/height on product_media rows that have a URL but no
 * stored dimensions. Fetches each image and reads metadata via sharp.
 *
 * Run: npx tsx scripts/backfill-product-media-dims.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const sharp = (await import("sharp")).default;
  const admin = createAdminClient();

  const { data: rows } = await admin.from("product_media")
    .select("id, slot, url, width, height")
    .not("url", "is", null)
    .or("width.is.null,height.is.null");

  console.log(`${rows?.length || 0} rows to backfill`);
  let ok = 0, fail = 0;
  for (const r of rows || []) {
    if (!r.url) continue;
    try {
      const res = await fetch(r.url);
      if (!res.ok) { console.log(`  fetch fail ${r.slot}: ${res.status}`); fail++; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(buf).metadata();
      if (!meta.width || !meta.height) { console.log(`  no metadata ${r.slot}`); fail++; continue; }
      await admin.from("product_media").update({
        width: meta.width, height: meta.height, updated_at: new Date().toISOString(),
      }).eq("id", r.id);
      console.log(`  ✓ ${r.slot}: ${meta.width}×${meta.height}`);
      ok++;
    } catch (err) {
      console.error(`  fail ${r.slot}:`, err instanceof Error ? err.message : err);
      fail++;
    }
  }
  console.log(`\nBackfilled ${ok}, failed ${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
