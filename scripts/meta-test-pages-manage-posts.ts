/**
 * Exercise the pages_manage_posts permission for Meta App Review.
 * Their reviewer team checks API call logs to verify the app
 * actually uses the requested scope. We create an unpublished
 * test post (published=false, never visible to followers) and
 * then delete it. Two distinct calls cover both common usages:
 *   POST /{page-id}/feed   — create
 *   DELETE /{post-id}      — delete
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

  const testMessage = `[App-review test ${new Date().toISOString()}] Verifying pages_manage_posts permission. This post is unpublished (draft only — not visible to followers) and will be deleted by the same script immediately after creation.`;

  // 1. CREATE — POST /{page-id}/feed with published=false
  console.log("=== STEP 1: CREATE unpublished post ===");
  const createUrl = `https://graph.facebook.com/v21.0/${pageId}/feed`;
  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      message: testMessage,
      published: "false",
      access_token: token,
    }).toString(),
  });
  const createBody = await createRes.text();
  console.log(`status: ${createRes.status}`);
  console.log(`body  : ${createBody}`);
  if (!createRes.ok) {
    console.error("✗ create failed — stopping (no post to delete)");
    return;
  }
  const created = JSON.parse(createBody) as { id?: string };
  if (!created.id) {
    console.error("✗ create returned no id");
    return;
  }
  console.log(`✓ created post id ${created.id}`);

  // Brief pause so the post is fully indexed before we delete
  await new Promise((r) => setTimeout(r, 1500));

  // 2. DELETE — DELETE /{post-id}
  console.log("\n=== STEP 2: DELETE the test post ===");
  const deleteUrl = `https://graph.facebook.com/v21.0/${created.id}?access_token=${encodeURIComponent(token)}`;
  const delRes = await fetch(deleteUrl, { method: "DELETE" });
  const delBody = await delRes.text();
  console.log(`status: ${delRes.status}`);
  console.log(`body  : ${delBody}`);
  if (delRes.ok) console.log("✓ deleted");
  else console.error("✗ delete failed — manually clean up post id", created.id);
}
main().catch(e => { console.error(e); process.exit(1); });
