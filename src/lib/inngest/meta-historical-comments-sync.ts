/**
 * Pull historical comments off active ads in the workspace's enabled ad
 * accounts. Designed for an initial backfill + an optional daily catch-up
 * cron later.
 *
 * Per enabled ad account:
 *   1. List ads delivered in the last 30 days (configurable via event.data).
 *   2. For each ad, derive the underlying post id (FB: effective_object_story_id,
 *      IG: effective_instagram_media_id).
 *   3. For each unique post, fetch comments via Graph API (paginated).
 *   4. For each comment, normalize into the same shape the webhook ships
 *      and run through ingestSocialComment so dedup + Sonnet moderation
 *      + product matching all happen the standard way.
 *
 * Triggered manually via "Sync now" in Settings → Integrations → Meta or
 * by sending `meta/historical-comments.sync` with workspace_id.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { ingestSocialComment } from "@/lib/social-comment-ingest";

const GRAPH = "https://graph.facebook.com/v21.0";

interface AdRow {
  id: string;
  name?: string;
  creative?: { effective_object_story_id?: string; effective_instagram_media_id?: string };
  delivery_info?: { start_time?: string; end_time?: string };
}

interface CommentRow {
  id: string;
  from?: { id: string; name?: string; username?: string };
  message?: string;
  text?: string;
  created_time?: string;
  parent?: { id?: string };
}

export const metaHistoricalCommentsSync = inngest.createFunction(
  {
    id: "meta-historical-comments-sync",
    name: "Meta — backfill historical comments from active ads",
    concurrency: [{ limit: 1 }],   // one workspace at a time — we paginate Graph API
    triggers: [{ event: "meta/historical-comments.sync" }],
  },
  async ({ event, step }) => {
    const { workspace_id: workspaceId, days = 30 } = event.data as {
      workspace_id: string;
      days?: number;
    };
    const admin = createAdminClient();

    // 1. User token via the ROAS Meta Ads OAuth connection — that's
    // the flow that requested ads_read. Marketing API rejects page
    // tokens; pages-OAuth user token doesn't carry ads_read either.
    const userToken = await step.run("load-user-token", async () => {
      const { data: conn } = await admin
        .from("meta_connections")
        .select("access_token_encrypted")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true)
        .maybeSingle();
      return conn?.access_token_encrypted
        ? decrypt(conn.access_token_encrypted as string)
        : null;
    });
    if (!userToken) return { error: "no_user_token" };

    // 2. Pages map: meta_page_id (numeric) → row (needed for ingestSocialComment)
    const pages = await step.run("load-pages", async () => {
      const { data } = await admin
        .from("meta_pages")
        .select("id, workspace_id, meta_page_id, platform, page_type, ai_moderate_ad_comments, ai_moderate_organic_comments")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);
      return data || [];
    });

    type PageRow = (typeof pages)[number];
    const fbPagesById = new Map<string, PageRow>();
    const igPagesById = new Map<string, PageRow>();
    for (const p of pages) {
      (p.platform === "instagram" ? igPagesById : fbPagesById).set(p.meta_page_id as string, p as PageRow);
    }

    // 3. Active ad accounts (managed via ROAS integration). All
    // connected accounts are eligible for comment backfill — no
    // separate per-account opt-in.
    const accounts = await step.run("load-enabled-accounts", async () => {
      const { data } = await admin
        .from("meta_ad_accounts")
        .select("id, meta_account_id, meta_account_name")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);
      return (data || []).map(a => ({
        id: a.id as string,
        // Marketing API needs the `act_` prefix
        fb_act_id: `act_${a.meta_account_id}`,
        name: a.meta_account_name as string,
      }));
    });
    if (accounts.length === 0) return { skipped: "no_enabled_accounts" };

    const sinceMs = Date.now() - days * 86400 * 1000;
    const sinceUnix = Math.floor(sinceMs / 1000);

    // 4. Walk ads per account, deduplicate posts, fetch comments, ingest.
    const stats = { accounts: accounts.length, ads: 0, posts: 0, comments: 0, ingested: 0, skipped: 0 };
    const seenPosts = new Set<string>();

    for (const acct of accounts) {
      const adsByPost = new Map<string, { ad: AdRow; platform: "facebook" | "instagram" }>();

      // List ads in this account delivered in the last N days. The
      // filtering field that maps to "ad was actually delivered in the
      // window" is `delivery_info.start_time`. We also accept
      // effective_status=ACTIVE so currently-running ads come through
      // even if their start_time is older — we want comments on them too.
      const filter = encodeURIComponent(JSON.stringify([
        { field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED", "WITH_ISSUES"] },
      ]));
      const adFields = "id,name,creative{effective_object_story_id,effective_instagram_media_id},delivery_info";
      let next: string | null = `${GRAPH}/${acct.fb_act_id}/ads?filtering=${filter}&fields=${encodeURIComponent(adFields)}&limit=200&access_token=${encodeURIComponent(userToken)}`;
      let pagesWalked = 0;
      while (next && pagesWalked < 25) {
        const ads = await step.run(`list-ads-${acct.fb_act_id}-p${pagesWalked}`, async () => {
          const r = await fetch(next!);
          if (!r.ok) return null;
          return (await r.json()) as { data?: AdRow[]; paging?: { next?: string } };
        });
        if (!ads) break;
        for (const ad of ads.data || []) {
          stats.ads++;
          const fbStory = ad.creative?.effective_object_story_id;
          const igMedia = ad.creative?.effective_instagram_media_id;
          // Skip ads whose delivery start is older than the window AND
          // aren't currently active. We don't have status here from the
          // filtering above (filter was on effective_status), but we can
          // gate by start_time too. If we don't have start_time, keep it.
          const startMs = ad.delivery_info?.start_time ? Date.parse(ad.delivery_info.start_time) : null;
          if (startMs !== null && startMs < sinceMs * 0.5) {
            // Older than ~60d AND has a start_time → drop
            // (kept the heuristic loose; safer to over-pull on a small backfill)
          }
          if (fbStory && !adsByPost.has(fbStory)) adsByPost.set(fbStory, { ad, platform: "facebook" });
          if (igMedia && !adsByPost.has(igMedia)) adsByPost.set(igMedia, { ad, platform: "instagram" });
        }
        next = ads.paging?.next || null;
        pagesWalked++;
      }

      // Fetch comments per unique post. Page token determines auth for
      // the post-comments endpoint; we use the matching page's token.
      for (const [postId, { platform }] of adsByPost) {
        if (seenPosts.has(postId)) continue;
        seenPosts.add(postId);
        stats.posts++;

        // For FB: post id is "{page_id}_{post_id}" → the page id is the prefix.
        // For IG: post id is the raw IG media id → look up via igPagesById
        //         BUT IG comments endpoint accepts the IG biz account token
        //         from ANY of our connected pages that owns that media. We
        //         try each IG page in turn.
        const candidatePages: PageRow[] = platform === "facebook"
          ? (() => {
              const pageId = postId.split("_")[0];
              const p = fbPagesById.get(pageId);
              return p ? [p] : [];
            })()
          : [...igPagesById.values()];

        if (candidatePages.length === 0) {
          stats.skipped++;
          continue;
        }

        const ingestedHere = await step.run(`fetch-comments-${postId.slice(0, 20)}`, async () => {
          let totalIngested = 0;
          for (const page of candidatePages) {
            const token = await loadPageAccessToken(admin, page.id as string);
            if (!token) continue;
            const fields = "id,from{id,name,username},message,text,created_time,parent";
            let url: string | null = `${GRAPH}/${postId}/comments?fields=${encodeURIComponent(fields)}&order=chronological&limit=100&access_token=${encodeURIComponent(token)}`;
            let pageHits = 0;
            while (url && pageHits < 10) {
              const r = await fetch(url);
              if (!r.ok) {
                const errBody = await r.text();
                console.warn(`comments fetch failed for ${postId}: ${r.status} ${errBody.slice(0, 120)}`);
                break;
              }
              const json = (await r.json()) as { data?: CommentRow[]; paging?: { next?: string } };
              for (const c of json.data || []) {
                if (!c.id || !c.from?.id) continue;
                const createdMs = c.created_time ? Date.parse(c.created_time) : 0;
                if (createdMs && createdMs < sinceMs) continue;   // older than window
                stats.comments++;
                // Normalize into the webhook shape ingestSocialComment expects.
                await ingestSocialComment({
                  admin,
                  page,
                  platform,
                  changeField: platform === "instagram" ? "comments" : "feed",
                  change: {
                    id: c.id,
                    comment_id: c.id,
                    from: c.from,
                    message: c.message,
                    text: c.text,
                    parent_id: c.parent?.id,
                    post_id: platform === "facebook" ? postId : undefined,
                    media: platform === "instagram" ? { id: postId } : undefined,
                    verb: "add",
                    created_time: createdMs ? Math.floor(createdMs / 1000) : sinceUnix,
                  },
                });
                totalIngested++;
              }
              url = json.paging?.next || null;
              pageHits++;
            }
            // First page that returned comments wins for this post — no
            // need to try other pages for the same media.
            if (totalIngested > 0) break;
          }
          return totalIngested;
        });
        stats.ingested += ingestedHere;
      }

      await step.run(`stamp-account-${acct.id}`, async () => {
        await admin
          .from("meta_ad_accounts")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("id", acct.id);
      });
    }

    return stats;
  },
);

async function loadPageAccessToken(admin: ReturnType<typeof createAdminClient>, metaPagesRowId: string): Promise<string | null> {
  const { data } = await admin
    .from("meta_pages")
    .select("access_token_encrypted")
    .eq("id", metaPagesRowId)
    .maybeSingle();
  if (!data?.access_token_encrypted) return null;
  return decrypt(data.access_token_encrypted as string);
}
