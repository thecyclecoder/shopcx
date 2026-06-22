/**
 * Featured-review cards — daily cron (spec: automated-social-scheduler).
 *
 * Generates a few designed testimonial graphics from ShopCX **featured**
 * reviews and drops them into the ad library (`ad_videos` statics under a
 * "{Product} Reviews" campaign), at 9:16 + 4:5. The social poster picks them up
 * via `pickTestimonial`. Idempotent + finite: once every featured review has a
 * card, the daily run does nothing.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateFeaturedReviewCards } from "@/lib/social/featured-review-cards";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const featuredReviewCardsCron = inngest.createFunction(
  {
    id: "featured-review-cards",
    name: "Featured review cards — daily (3/day)",
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 11 * * *" }, { event: "featured-review-cards/tick" }],
  },
  async ({ event, step }) => {
    const data = (event?.data || {}) as { workspace_id?: string; count?: number };
    const perRun = data.count ?? 3;

    const workspaceIds = await step.run("eligible-workspaces", async () => {
      const admin = createAdminClient();
      if (data.workspace_id) return [data.workspace_id];
      const { data: rows } = await admin
        .from("product_reviews")
        .select("workspace_id")
        .eq("featured", true)
        .not("product_id", "is", null);
      return Array.from(new Set((rows || []).map((r) => String(r.workspace_id))));
    });

    const results: Array<{ workspace_id: string; made: number; remaining: number }> = [];
    for (const ws of workspaceIds) {
      const r = await step.run(`gen-${ws}`, () => generateFeaturedReviewCards(ws, perRun));
      results.push({ workspace_id: ws, made: r.made, remaining: r.remaining });
    }
    const result = { results };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("featured-review-cards", { ok: true, produced: result });
    });

    return result;
  },
);
