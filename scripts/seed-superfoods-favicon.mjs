// One-shot: pull Superfoods favicon from their existing site, drop it
// into our Supabase storage, and seed storefront_favicon_url so the
// storefront stops rendering with the ShopCX tab icon.

import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BUCKET = "product-media";

// Square logo PNG straight from Shopify CDN. Stripped of size query
// params so we get the original — sharp resizes locally.
const SOURCE_URL =
  "https://superfoodscompany.com/cdn/shop/files/Logo_Square_-_Small_10f0ab9b-ea0c-4dfa-bae8-0e936f350de3.jpg?v=1708454579";

async function main() {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("Fetching:", SOURCE_URL);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const inputBuffer = Buffer.from(await res.arrayBuffer());
  console.log("Got", inputBuffer.length, "bytes");

  // Same pipeline as the upload endpoint: square crop + 256 PNG.
  const pngBuffer = await sharp(inputBuffer)
    .rotate()
    .resize(256, 256, { fit: "cover", position: "center" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  console.log("Transcoded to PNG:", pngBuffer.length, "bytes");

  const stamp = Date.now();
  const path = `workspaces/${WORKSPACE_ID}/favicon/${stamp}.png`;
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, pngBuffer, {
    contentType: "image/png",
    upsert: true,
    cacheControl: "31536000",
  });
  if (upErr) throw upErr;

  const url = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  console.log("Uploaded to:", url);

  const { error: dbErr } = await admin
    .from("workspaces")
    .update({ storefront_favicon_url: url })
    .eq("id", WORKSPACE_ID);
  if (dbErr) throw dbErr;
  console.log("Seeded workspace.storefront_favicon_url");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
