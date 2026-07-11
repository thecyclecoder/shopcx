/**
 * Competitor Scout — discovery pass (docs/brain/specs/competitor-scout.md, Phase 1).
 *
 * Event-triggered LLM + web-search discovery for ONE product: proposes the competitive set WITH
 * evidence into the `competitors` table as status='proposed'. Never approves — the owner approves
 * via /api/ads/competitors/[id]. The category-sweep promotion signal runs inside the
 * creative-finder cron (it reads that cron's own sweep output).
 *
 * Trigger:
 *   event "ads/competitor-scout.discover" { workspaceId, productId } → discover competitors for one product
 *
 * See docs/brain/inngest/competitor-scout.md.
 */
import { inngest } from "./client";
import { discoverCompetitors } from "@/lib/competitors";
import { OUTAGE_SPANNING_RETRIES } from "@/lib/anthropic-retry";

export const competitorScoutDiscover = inngest.createFunction(
  { id: "competitor-scout-discover", retries: OUTAGE_SPANNING_RETRIES, triggers: [{ event: "ads/competitor-scout.discover" }] },
  async ({ event, step }) => {
    const { workspaceId, productId } = (event.data || {}) as {
      workspaceId?: string;
      productId?: string;
    };
    if (!workspaceId || !productId) return { skipped: "workspaceId+productId required" };

    const result = await step.run("discover", () => discoverCompetitors(workspaceId, productId));
    return { workspaceId, productId, ...result };
  },
);
