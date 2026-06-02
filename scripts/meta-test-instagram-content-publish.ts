/**
 * Exercise the instagram_content_publish permission for Meta App
 * Review. Reviewers verify the app uses the requested scope by
 * inspecting API call logs. Instagram's publish API is a 2-step
 * container flow:
 *   1. POST /{ig-user-id}/media         → creates an unpublished container
 *   2. POST /{ig-user-id}/media_publish → publishes the container
 *
 * We do step 1 only — container expires automatically after 24h
 * when unpublished, so nothing lands on the live IG account.
 * That single call is enough to register against the permission
 * in Meta's request logs.
 *
 * If the IG Business Account isn't yet linked to the FB page (the
 * usual pre-approval state), the resolution step itself surfaces
 * that as an actionable error.
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

const TEST_IMAGE = "https://cdn.shopify.com/s/files/1/0634/9599/5565/files/PDP_Amazing_Coffee.jpg";
const TEST_CAPTION = `[App-review test ${new Date().toISOString()}] Verifying instagram_content_publish permission. This media container is created unpublished — it will expire automatically after 24 hours without going live to followers.`;

async function main() {
  const { data: ws } = await admin
    .from("workspaces")
    .select("meta_page_access_token_encrypted, meta_page_id, meta_instagram_id")
    .eq("id", "fdc11e10-b89f-4989-8b73-ed6526c4d906").single();
  const { decrypt } = await import("../src/lib/crypto");
  const token = decrypt(ws!.meta_page_access_token_encrypted as string);
  const pageId = ws!.meta_page_id as string;
  let igUserId: string | null = (ws!.meta_instagram_id as string | null) || null;

  // 1. Resolve the Instagram Business Account ID from the page if
  // we don't have it stored. Required field for both /media and
  // /media_publish endpoints.
  if (!igUserId) {
    console.log("=== STEP 0: resolve Instagram Business Account from page ===");
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${pageId}?fields=instagram_business_account&access_token=${encodeURIComponent(token)}`
    );
    const body = await r.text();
    console.log(`status: ${r.status}`);
    console.log(`body  : ${body}`);
    if (!r.ok) { console.error("✗ couldn't fetch page → IG mapping"); return; }
    const parsed = JSON.parse(body) as { instagram_business_account?: { id: string } };
    if (!parsed.instagram_business_account?.id) {
      console.error("\n✗ No Instagram Business Account linked to this Facebook page.");
      console.error("  Link an IG Business/Creator account to the FB page in Meta Business Settings,");
      console.error("  then re-run this script.");
      return;
    }
    igUserId = parsed.instagram_business_account.id;
    console.log(`✓ IG user id: ${igUserId}`);
  }

  // 2. CREATE — POST /{ig-user-id}/media (unpublished container)
  console.log("\n=== STEP 1: POST /{ig-user-id}/media (create unpublished container) ===");
  const createRes = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      image_url: TEST_IMAGE,
      caption: TEST_CAPTION,
      access_token: token,
    }).toString(),
  });
  const createBody = await createRes.text();
  console.log(`status: ${createRes.status}`);
  console.log(`body  : ${createBody}`);
  if (!createRes.ok) {
    console.error("\n(403 here is the expected pre-approval state — Meta's reviewer can see the call in their logs)");
    return;
  }

  const created = JSON.parse(createBody) as { id?: string };
  if (!created.id) { console.error("✗ create returned no creation_id"); return; }
  console.log(`✓ created media container ${created.id}`);
  console.log("\nNote: container is UNPUBLISHED and will expire automatically in ~24h.");
  console.log("To exercise the second half of the permission (actual publish), uncomment");
  console.log("the publish block at the bottom of this script. It's commented out by");
  console.log("default so an accidental run doesn't post to the live IG account.");

  // 3. PUBLISH (commented out — uncomment to post live to IG)
  // console.log("\n=== STEP 2: POST /{ig-user-id}/media_publish ===");
  // const pubRes = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media_publish`, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/x-www-form-urlencoded" },
  //   body: new URLSearchParams({ creation_id: created.id, access_token: token }).toString(),
  // });
  // console.log(`status: ${pubRes.status}`);
  // console.log(`body  : ${await pubRes.text()}`);
}
main().catch(e => { console.error(e); process.exit(1); });
