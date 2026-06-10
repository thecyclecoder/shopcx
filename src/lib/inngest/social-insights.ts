/**
 * Daily Meta Insights sync for the social scheduler's optimizer.
 * See docs/brain/specs/automated-social-scheduler.md § Phase 5.
 *
 * For each scheduler-enabled workspace: refresh per-post engagement on recently
 * posted items, and refresh the audience-online heatmap per IG page. The
 * planner's optimizer reads both to choose post times.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { syncPostMetrics, syncAudienceHours } from "@/lib/social/insights";

export const socialInsightsSync = inngest.createFunction(
  {
    id: "social-insights-sync",
    name: "Social — daily Meta Insights sync",
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "30 8 * * *" }, { event: "social/insights.tick" }],
  },
  async ({ step }) => {
    const workspaces = await step.run("load-workspaces", async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("workspaces").select("id, social_scheduler_config");
      return (data || [])
        .map((w) => ({ id: w.id as string, cfg: (w.social_scheduler_config || {}) as { enabled?: boolean; target_meta_page_ids?: string[] } }))
        .filter((w) => w.cfg?.enabled && w.cfg?.target_meta_page_ids?.length);
    });

    let posts = 0, pages = 0;
    for (const ws of workspaces) {
      // Per-post metrics — recently posted, refreshed at most daily.
      posts += await step.run(`metrics-${ws.id}`, async () => {
        const admin = createAdminClient();
        const { data: recent } = await admin.from("scheduled_social_posts")
          .select("id")
          .eq("workspace_id", ws.id).eq("status", "posted")
          .gte("scheduled_at", new Date(Date.now() - 14 * 86_400_000).toISOString())
          .or(`metrics_synced_at.is.null,metrics_synced_at.lt.${new Date(Date.now() - 20 * 3_600_000).toISOString()}`)
          .limit(100);
        let n = 0;
        for (const p of recent || []) { if (await syncPostMetrics(admin, p.id)) n++; }
        return n;
      });

      // Audience-online heatmap per IG page in the target list.
      pages += await step.run(`audience-${ws.id}`, async () => {
        const admin = createAdminClient();
        const { data: igPages } = await admin.from("meta_pages")
          .select("id, meta_instagram_id, meta_page_id, access_token_encrypted")
          .in("id", ws.cfg.target_meta_page_ids!).eq("platform", "instagram").eq("is_active", true);
        let n = 0;
        for (const pg of igPages || []) {
          if (!pg.access_token_encrypted) continue;
          let token: string; try { token = decrypt(pg.access_token_encrypted); } catch { continue; }
          const igId = String(pg.meta_instagram_id || pg.meta_page_id);
          if (await syncAudienceHours(admin, ws.id, pg.id, igId, token)) n++;
        }
        return n;
      });
    }
    return { workspaces: workspaces.length, posts_synced: posts, pages_synced: pages };
  },
);
