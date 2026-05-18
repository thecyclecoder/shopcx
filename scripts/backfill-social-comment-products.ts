/**
 * Backfill social_comments.matched_product_id (and meta_post_cache.matched_product_id
 * / is_ad) for comments that landed before the media-id-based ad lookup
 * was wired up.
 *
 * For each distinct (workspace_id, meta_post_id) on social_comments:
 *   1. Reuse the existing cache row's matched_product_id if already set.
 *   2. Otherwise, look up the ad creative via getAdDestinationUrlsByMediaId
 *      (uses effective_instagram_media_id for IG, effective_object_story_id for FB).
 *   3. Feed URLs into resolvePostProductMatch to get the product UUID.
 *   4. Write back to meta_post_cache + every social_comments row sharing that
 *      post_id.
 *
 * Also flips meta_post_cache.is_ad → true when a creative match is found
 * (regardless of whether the original webhook had ad_id) and pushes that
 * flag down to social_comments.
 *
 * Run: npx tsx scripts/backfill-social-comment-products.ts [--apply]
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../src/lib/crypto";
import { getAdDestinationUrlsByMediaId } from "../src/lib/meta";
import { resolvePostProductMatch } from "../src/lib/meta-product-match";

async function main() {
  const envPath = resolve(process.cwd(), ".env.local");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq < 0) continue;
    const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const APPLY = process.argv.includes("--apply");

  // Pull every distinct (workspace, post) pair from social_comments
  const { data: comments } = await sb
    .from("social_comments")
    .select("id, workspace_id, meta_post_id, meta_page_id, matched_product_id, is_ad");
  if (!comments?.length) { console.log("No comments."); return; }

  // Group by (workspace_id, meta_post_id)
  type Group = { workspaceId: string; postId: string; pageRowId: string; rows: typeof comments };
  const groups = new Map<string, Group>();
  for (const c of comments) {
    const k = `${c.workspace_id}|${c.meta_post_id}`;
    if (!groups.has(k)) groups.set(k, { workspaceId: c.workspace_id as string, postId: c.meta_post_id as string, pageRowId: c.meta_page_id as string, rows: [] });
    groups.get(k)!.rows.push(c);
  }
  console.log(`${comments.length} comments across ${groups.size} unique posts`);

  // Cache workspace-level resources to avoid re-fetching per group
  const userTokenByWs = new Map<string, string | null>();
  const platformByPageRow = new Map<string, "facebook" | "instagram">();

  for (const g of groups.values()) {
    // Cache row first
    const { data: cached } = await sb
      .from("meta_post_cache")
      .select("matched_product_id, is_ad")
      .eq("workspace_id", g.workspaceId)
      .eq("meta_post_id", g.postId)
      .maybeSingle();

    let matchedProductId = cached?.matched_product_id || null;
    let isAd = cached?.is_ad || false;
    let urls: string[] = [];

    if (!matchedProductId) {
      // Need to resolve. Fetch user token + page platform.
      if (!userTokenByWs.has(g.workspaceId)) {
        const { data: ws } = await sb.from("workspaces").select("meta_user_access_token_encrypted").eq("id", g.workspaceId).maybeSingle();
        userTokenByWs.set(g.workspaceId, ws?.meta_user_access_token_encrypted ? decrypt(ws.meta_user_access_token_encrypted as string) : null);
      }
      const userToken = userTokenByWs.get(g.workspaceId);

      if (!platformByPageRow.has(g.pageRowId)) {
        const { data: pr } = await sb.from("meta_pages").select("platform").eq("id", g.pageRowId).single();
        platformByPageRow.set(g.pageRowId, pr?.platform as "facebook" | "instagram");
      }
      const platform = platformByPageRow.get(g.pageRowId);

      if (userToken && platform) {
        urls = await getAdDestinationUrlsByMediaId(userToken, g.postId, platform);
        if (urls.length) {
          matchedProductId = await resolvePostProductMatch(sb as never, g.workspaceId, urls);
          isAd = true;  // matching creative = it's an ad
        }
      }
    }

    console.log(`  ${g.postId} | platform=${platformByPageRow.get(g.pageRowId)} | urls=[${urls.join(", ")}] | matched=${matchedProductId || "—"} | is_ad=${isAd} | rows=${g.rows.length}`);

    if (!APPLY) continue;

    // Upsert cache row
    await sb.from("meta_post_cache").upsert({
      workspace_id: g.workspaceId,
      meta_page_id: g.pageRowId,
      meta_post_id: g.postId,
      matched_product_id: matchedProductId,
      is_ad: isAd,
      extracted_urls: urls,
    }, { onConflict: "workspace_id,meta_post_id" });

    // Push to comments
    if (matchedProductId || isAd) {
      const ids = g.rows.map((r) => r.id as string);
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (matchedProductId) patch.matched_product_id = matchedProductId;
      if (isAd) patch.is_ad = true;
      await sb.from("social_comments").update(patch).in("id", ids);
    }
  }

  if (!APPLY) console.log("\n(dry run — pass --apply to write)");
  else console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
