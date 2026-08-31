/**
 * Inngest cron: push our review aggregates into Shopify's `reviews.rating` +
 * `reviews.rating_count` product metafields.
 *
 * These metafields drive every star on the Shopify storefront — PDP ratings,
 * collection + recommendation cards, and the Google rich-snippet
 * `aggregateRating` in `snippets/product-schema.liquid`. The Klaviyo Reviews
 * app used to write them; it is retired ([[klaviyo-retired]]), and its values
 * disappear with the app. This cron takes over that job from our own
 * `product_reviews` table.
 *
 * Daily at 09:00 UTC — after the overnight order/review activity, before US
 * morning traffic. Cadence + liveness window are pinned in
 * [[../control-tower/registry]] (daily ⇒ 30h window per the monitor-cadence
 * invariant).
 *
 * All the real work — aggregation, Shopify batching, partial-failure handling —
 * lives in [[../shopify-review-metafields]]. This file is the schedule + the
 * heartbeat.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";
import { syncReviewMetafields, type SyncResult } from "@/lib/shopify-review-metafields";

export const shopifyReviewMetafieldsSync = inngest.createFunction(
  {
    id: "shopify-review-metafields-sync",
    name: "Shopify — push review aggregates to product rating metafields (daily)",
    concurrency: [{ limit: 1 }],
    retries: 2,
    triggers: [
      { cron: "0 9 * * *" },
      { event: "reviews/shopify-metafields.sync" },
    ],
  },
  async ({ event, step }) => {
    if ((await enforceSwitch("shopify-review-metafields-sync")).ok === "blocked_off") return;

    const single = (event?.data as { workspace_id?: string } | undefined)?.workspace_id;

    const workspaceIds = await step.run("fetch-workspaces", async () => {
      if (single) return [single];
      const admin = createAdminClient();
      const { data } = await admin
        .from("workspaces")
        .select("id")
        .not("shopify_access_token_encrypted", "is", null);
      return (data || []).map((w) => w.id as string);
    });

    const results: SyncResult[] = [];
    for (const workspaceId of workspaceIds) {
      const res = await step.run(`sync-${workspaceId}`, () => syncReviewMetafields(workspaceId));
      results.push(res);
    }

    const summary = {
      workspaces: results.length,
      products: results.reduce((n, r) => n + r.products, 0),
      written: results.reduce((n, r) => n + r.written, 0),
      errors: results.flatMap((r) => r.errors).slice(0, 10),
    };

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("shopify-review-metafields-sync", {
        ok: summary.errors.length === 0,
        produced: summary,
      });
    });

    return summary;
  },
);
