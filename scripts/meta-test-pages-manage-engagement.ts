/**
 * Exercise the pages_manage_engagement permission for Meta App
 * Review. Their reviewers check API call logs to confirm the app
 * actually uses the requested scope. We pull the latest post from
 * the page feed, like it as the page, then immediately unlike it.
 * Two distinct calls covering both write directions:
 *   POST   /{post-id}/likes  — engagement create (the page likes a post)
 *   DELETE /{post-id}/likes  — engagement remove (the page unlikes)
 *
 * Reversible / safe — nothing user-visible is left behind.
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

async function main() {
  const { data: ws } = await admin
    .from("workspaces")
    .select("meta_page_access_token_encrypted, meta_page_id")
    .eq("id", "fdc11e10-b89f-4989-8b73-ed6526c4d906").single();
  const { decrypt } = await import("../src/lib/crypto");
  const token = decrypt(ws!.meta_page_access_token_encrypted as string);
  const pageId = ws!.meta_page_id as string;

  // 1. Find the latest post on the page so we have a real target
  console.log("=== STEP 1: find a recent post to act on ===");
  const feedRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed?fields=id,created_time,message&limit=1&access_token=${encodeURIComponent(token)}`);
  const feedBody = await feedRes.text();
  console.log("feed status:", feedRes.status);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = JSON.parse(feedBody) as { data?: any[] };
  const post = feed?.data?.[0];
  if (!post?.id) { console.error("✗ no post found on feed"); return; }
  console.log(`✓ target post id ${post.id}  created ${post.created_time}`);

  // 2. LIKE the post as the page
  console.log("\n=== STEP 2: POST /{post-id}/likes (page likes the post) ===");
  const likeRes = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(post.id)}/likes`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: token }).toString(),
  });
  const likeBody = await likeRes.text();
  console.log(`status: ${likeRes.status}`);
  console.log(`body  : ${likeBody}`);

  // Small pause so the engagement is registered before we reverse it
  await new Promise((r) => setTimeout(r, 1500));

  // 3. UNLIKE — clean state
  console.log("\n=== STEP 3: DELETE /{post-id}/likes (page unlikes the post) ===");
  const unlikeRes = await fetch(
    `https://graph.facebook.com/v21.0/${encodeURIComponent(post.id)}/likes?access_token=${encodeURIComponent(token)}`,
    { method: "DELETE" }
  );
  const unlikeBody = await unlikeRes.text();
  console.log(`status: ${unlikeRes.status}`);
  console.log(`body  : ${unlikeBody}`);
}
main().catch(e => { console.error(e); process.exit(1); });
