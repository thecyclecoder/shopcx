/**
 * Re-classify every cached post + its social_comments rows using the
 * 3-signal ad cascade (webhook ad_id → is_published=false → currently
 * promoted). is_published=false reliably catches dark posts that
 * promotion_status would otherwise miss (Suzy Doucet false-negative).
 *
 * Heuristic cascade (matches src/lib/social-comment-ingest.ts):
 *   1. webhook ad_id on the original     → ad
 *   2. is_published === false           → dark post (ad)
 *   3. promotion_status active/extendable → ad
 *   else                                 → organic
 *
 * Writes:
 *   meta_post_cache.{is_ad, matched_product_id, extracted_urls}
 *   social_comments.{is_ad, matched_product_id}
 *
 * Run:
 *   npx tsx scripts/backfill-social-comment-is-ad-jit.ts          (dry)
 *   npx tsx scripts/backfill-social-comment-is-ad-jit.ts --apply  (writes)
 */
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../src/lib/crypto";
import { getPostMetadata } from "../src/lib/meta";
import { resolvePostProductMatch, matchPostToProductViaAI } from "../src/lib/meta-product-match";

const APPLY = process.argv.includes("--apply");
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

interface CommentRow {
  id: string;
  workspace_id: string;
  meta_post_id: string;
  meta_page_id: string;
  ad_id: string | null;
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // 2. Pull every social_comments row + group by post
  const { data: comments } = await sb.from("social_comments")
    .select("id, workspace_id, meta_post_id, meta_page_id, ad_id")
    .eq("workspace_id", WS) as { data: CommentRow[] | null };
  if (!comments?.length) { console.log("no comments"); return; }

  // 3. Cache platform per meta_pages row
  const { data: pages } = await sb.from("meta_pages")
    .select("id, platform, access_token_encrypted").eq("workspace_id", WS);
  const platformByPage = new Map<string, "facebook" | "instagram">();
  const tokenByPage = new Map<string, string>();
  for (const p of pages || []) {
    platformByPage.set(p.id as string, p.platform as "facebook" | "instagram");
    if (p.access_token_encrypted) {
      try { tokenByPage.set(p.id as string, decrypt(p.access_token_encrypted as string)); } catch { /* skip */ }
    }
  }

  // 4. Group
  type Group = {
    workspaceId: string;
    postId: string;
    pageRowId: string;
    platform: "facebook" | "instagram";
    rows: CommentRow[];
    webhookAdId: string | null;
  };
  const groups = new Map<string, Group>();
  for (const c of comments) {
    const k = `${c.workspace_id}|${c.meta_post_id}`;
    const platform = platformByPage.get(c.meta_page_id);
    if (!platform || !c.meta_post_id) continue;
    if (!groups.has(k)) {
      groups.set(k, {
        workspaceId: c.workspace_id,
        postId: c.meta_post_id,
        pageRowId: c.meta_page_id,
        platform,
        rows: [],
        webhookAdId: null,
      });
    }
    const g = groups.get(k)!;
    g.rows.push(c);
    if (c.ad_id) g.webhookAdId = c.ad_id;  // any row with ad_id sets the flag
  }
  console.log(`${comments.length} comments across ${groups.size} unique posts\n`);

  // 5. Iterate
  let adCount = 0, organicCount = 0, errors = 0;
  for (const g of groups.values()) {
    const pageToken = tokenByPage.get(g.pageRowId);
    if (!pageToken) { errors++; continue; }

    let meta = null;
    try { meta = await getPostMetadata(pageToken, g.postId); } catch { /* */ }

    const promotionStatus = (meta?.promotion_status || "").toLowerCase();
    const isCurrentlyPromoted = promotionStatus === "extendable"
      || promotionStatus === "not_extendable"
      || promotionStatus === "active";
    const isAd = !!g.webhookAdId || meta?.is_published === false || isCurrentlyPromoted;
    if (isAd) adCount++; else organicCount++;

    // Product match off the post's body + attachment URLs.
    let matchedProductId: string | null = null;
    const allUrls: string[] = [];
    if (meta) {
      const re = /https?:\/\/[^\s)]+/g;
      const text = meta.message || "";
      const m = text.match(re) || [];
      for (const u of m) allUrls.push(u.replace(/[)>,.!?]+$/, ""));
      for (const att of meta.attachments?.data || []) {
        if (att.target?.url) allUrls.push(att.target.url);
        if (att.url) allUrls.push(att.url);
        for (const sub of att.subattachments?.data || []) {
          if (sub.target?.url) allUrls.push(sub.target.url);
        }
      }
    }
    const urls = [...new Set(allUrls)];
    if (urls.length) {
      try {
        matchedProductId = await resolvePostProductMatch(sb as never, g.workspaceId, urls);
      } catch (e) {
        console.warn(`  ! ${g.postId} product match failed:`, e instanceof Error ? e.message : e);
      }
    }
    // Haiku fallback for posts the URL matcher couldn't resolve.
    if (!matchedProductId && meta?.message) {
      try {
        matchedProductId = await matchPostToProductViaAI(sb as never, g.workspaceId, meta.message);
      } catch (e) {
        console.warn(`  ! ${g.postId} AI match failed:`, e instanceof Error ? e.message : e);
      }
    }

    const reason = g.webhookAdId ? "webhook_ad_id" : meta?.is_published === false ? "dark_post" : isCurrentlyPromoted ? "promotion_status" : "—";
    console.log(`  ${g.postId.slice(0, 28).padEnd(28)} | ${g.platform.padEnd(9)} | ${isAd ? "AD " : "org"} (${reason}) | product=${matchedProductId ? matchedProductId.slice(0, 8) : "—"} | rows=${g.rows.length}`);

    if (!APPLY) continue;

    // Upsert cache
    await sb.from("meta_post_cache").upsert({
      workspace_id: g.workspaceId,
      meta_page_id: g.pageRowId,
      meta_post_id: g.postId,
      is_ad: isAd,
      ad_id: g.webhookAdId,
      permalink_url: meta?.permalink_url || null,
      message: meta?.message || null,
      posted_at: meta?.created_time ? new Date(meta.created_time).toISOString() : null,
      extracted_urls: urls,
      matched_product_id: matchedProductId,
    }, { onConflict: "workspace_id,meta_post_id" });

    // Push to social_comments
    const ids = g.rows.map(r => r.id);
    const patch: Record<string, unknown> = { is_ad: isAd, updated_at: new Date().toISOString() };
    if (matchedProductId) patch.matched_product_id = matchedProductId;
    await sb.from("social_comments").update(patch).in("id", ids);
  }

  console.log(`\nDone. ads=${adCount} organic=${organicCount} errors=${errors}`);
  if (!APPLY) console.log("(dry run — pass --apply to write)");
}
main().catch(e => { console.error(e); process.exit(1); });
