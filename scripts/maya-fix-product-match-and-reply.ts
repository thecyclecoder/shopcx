/**
 * Fix Maya Agha's social comment:
 *  1. Match it to the Superfood Tabs product (the post links to
 *     superfoodscompany.com/products/superfood-tabs)
 *  2. Insert a social_comment_replies row for the reply we sent via
 *     the FB API earlier — without this row the dashboard
 *     conversation panel doesn't render the response
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COMMENT_ROW_ID = "1d0dc052-2434-40c6-957e-a86ba4ac3f06";
const SENT_REPLY = "Hi Maya! Mixed Berry should be back in stock around July 9 — drop your email on the product page and we'll send you a notification the moment it's available. Thanks for your patience! 💙";
const META_REPLY_ID = "843308941136121_860037209933243";

async function main() {
  // 1. Find Superfood Tabs by handle
  const { data: product } = await admin.from("products").select("id, title")
    .eq("workspace_id", WS).eq("handle", "superfood-tabs").single();
  if (!product) throw new Error("product not found");
  console.log(`→ Superfood Tabs product: ${product.id} (${product.title})`);

  // 2. Match the comment
  await admin.from("social_comments").update({
    matched_product_id: product.id,
    updated_at: new Date().toISOString(),
  }).eq("id", COMMENT_ROW_ID);
  console.log(`✓ social_comments.matched_product_id updated`);

  // 3. Insert the reply row so it shows in the UI
  const { data: msg, error } = await admin.from("social_comment_replies").insert({
    workspace_id: WS,
    social_comment_id: COMMENT_ROW_ID,
    meta_reply_id: META_REPLY_ID,
    direction: "outbound",
    author_type: "agent",
    body: SENT_REPLY,
    send_status: "sent",
  }).select("id").single();
  if (error) throw error;
  console.log(`✓ inserted social_comment_replies row ${msg?.id}`);
}
main().catch(e => { console.error("✗", e); process.exit(1); });
