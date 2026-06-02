/**
 * Backfill is_ad on social_comments + meta_post_cache using the
 * corrected heuristic (ad_id || promotion_status ∈ {extendable,
 * not_extendable, active}). Re-fetches each cached post once to
 * read promotion_status from Meta, then flips is_ad on every
 * social_comments row pointing to that post.
 *
 * Idempotent. Skips posts already correctly classified.
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

const ACTIVE_PROMOTION_STATUSES = new Set(["extendable", "not_extendable", "active"]);

async function main() {
  const { decrypt } = await import("../src/lib/crypto");

  // Index page tokens by meta_pages.id
  const { data: pages } = await admin
    .from("meta_pages")
    .select("id, meta_page_id, access_token_encrypted")
    .eq("workspace_id", WS)
    .eq("platform", "facebook");
  const tokenByPageId = new Map((pages || []).map(p => [p.id as string, decrypt(p.access_token_encrypted as string)]));
  const tokenByMetaPageId = new Map((pages || []).map(p => [p.meta_page_id as string, decrypt(p.access_token_encrypted as string)]));

  // All cached posts currently marked is_ad=true. Re-verify each.
  const { data: cachedPosts } = await admin
    .from("meta_post_cache")
    .select("id, meta_post_id, meta_page_id, ad_id, is_ad")
    .eq("workspace_id", WS)
    .eq("is_ad", true);
  console.log(`is_ad=true cached posts: ${cachedPosts?.length || 0}\n`);

  let flipped = 0;
  let kept = 0;
  let unfetched = 0;

  for (const p of cachedPosts || []) {
    // ad_id present → keep as ad (definitive signal from webhook)
    if (p.ad_id) { kept++; continue; }

    const token = tokenByPageId.get(p.meta_page_id as string) || tokenByMetaPageId.get(p.meta_page_id as string);
    if (!token) { unfetched++; continue; }

    const res = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(p.meta_post_id as string)}?fields=promotion_status&access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) { unfetched++; continue; }
    const data = (await res.json()) as { promotion_status?: string };
    const status = (data.promotion_status || "").toLowerCase();
    const isCurrentlyAd = ACTIVE_PROMOTION_STATUSES.has(status);

    if (isCurrentlyAd) { kept++; continue; }

    // Flip — was false-flagged
    await admin.from("meta_post_cache").update({ is_ad: false }).eq("id", p.id);
    const { error: cErr } = await admin
      .from("social_comments")
      .update({ is_ad: false, updated_at: new Date().toISOString() })
      .eq("workspace_id", WS)
      .eq("meta_post_id", p.meta_post_id as string);
    if (cErr) {
      console.warn(`  ! social_comments update failed for ${p.meta_post_id}:`, cErr.message);
      continue;
    }
    console.log(`  → ${p.meta_post_id}  promotion_status=${status || "(empty)"}  flipped is_ad=false`);
    flipped++;
  }

  console.log(`\nDone — flipped ${flipped}, kept ${kept} (actual ads), couldn't verify ${unfetched}`);
}
main().catch(e => { console.error(e); process.exit(1); });
