/**
 * Reply to Maya Agha's public comment on the Superfoods Company FB
 * ad: "Is the berry flavor back in stock?" The AI's initial reply
 * was generic ("check the product page"); we want to confirm the
 * actual expected restock date (July 9).
 *
 * Uses pages_manage_engagement to POST /{comment-id}/comments — the
 * same scope our app-review tests confirmed works on Superfoods.
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

const COMMENT_ROW_ID = "1d0dc052-2434-40c6-957e-a86ba4ac3f06";
const REPLY = "Hi Maya! Mixed Berry should be back in stock around July 9 — drop your email on the product page and we'll send you a notification the moment it's available. Thanks for your patience! 💙";

async function main() {
  const { data: c } = await admin
    .from("social_comments")
    .select("id, meta_comment_id, meta_page_id, body, meta_sender_name")
    .eq("id", COMMENT_ROW_ID).single();
  if (!c) throw new Error("comment row not found");
  console.log(`target: ${c.meta_sender_name} — "${c.body}"`);
  console.log(`comment id: ${c.meta_comment_id}`);

  const { data: page } = await admin
    .from("meta_pages")
    .select("meta_page_id, meta_page_name, access_token_encrypted")
    .eq("id", c.meta_page_id).single();
  if (!page) throw new Error("meta_pages row not found");
  console.log(`page: ${page.meta_page_name} (${page.meta_page_id})`);

  const { decrypt } = await import("../src/lib/crypto");
  const token = decrypt(page.access_token_encrypted as string);

  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(c.meta_comment_id)}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: REPLY, access_token: token }).toString(),
  });
  const text = await res.text();
  console.log(`\nPOST ${url.split("?")[0]}`);
  console.log(`status: ${res.status}`);
  console.log(`body  : ${text}`);
  if (!res.ok) throw new Error("reply failed");

  // Parse the new comment id so we can record it
  let newCommentId: string | null = null;
  try { newCommentId = (JSON.parse(text) as { id?: string }).id || null; } catch { /* */ }

  await admin.from("social_comments").update({
    replied_at: new Date().toISOString(),
    ai_reply_body: REPLY,
    status: "replied",
    updated_at: new Date().toISOString(),
  }).eq("id", COMMENT_ROW_ID);
  console.log(`\n✓ posted reply${newCommentId ? ` (new comment id ${newCommentId})` : ""}`);
}
main().catch(e => { console.error("✗", e); process.exit(1); });
