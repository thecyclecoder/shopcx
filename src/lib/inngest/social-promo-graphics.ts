/**
 * Generate a social promo's AI graphics asynchronously (Nano Banana Pro
 * composition takes ~30-60s for both ratios). Fired when an operator creates
 * a promo with an emphasis product, or hits "regenerate".
 * See docs/brain/specs/automated-social-scheduler.md.
 */
import { inngest } from "@/lib/inngest/client";
import { generatePromoGraphics } from "@/lib/social/promo-graphics";

export const socialPromoGraphics = inngest.createFunction(
  {
    id: "social-promo-graphics",
    name: "Social — generate promo graphics",
    concurrency: [{ limit: 2 }],
    retries: 1,
    triggers: [{ event: "social/promo.graphics" }],
  },
  async ({ event }) => {
    const { workspace_id, campaign_id } = event.data as { workspace_id: string; campaign_id: string };
    if (!workspace_id || !campaign_id) return { error: "missing ids" };
    return generatePromoGraphics(workspace_id, campaign_id);
  },
);
