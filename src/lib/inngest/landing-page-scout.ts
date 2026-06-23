/**
 * Landing Page Scout — vision gap-analysis pass (docs/brain/specs/landing-page-scout.md, Phase 1).
 *
 * Event-triggered vision gap-analysis over already-captured lander snapshots: compares the latest
 * competitor lander snapshots against ours, chapter by chapter, and writes proposed
 * lander_recommendations (status='proposed'). Never approves — the owner approves via
 * /api/ads/lander-recommendations/[id], which then routes to Build / the optimizer.
 *
 * The mobile per-chapter CAPTURE is a box script (scripts/landing-page-snapshot.ts) — Playwright can't
 * run in serverless. This function runs only the parts that can: the Anthropic vision call + the
 * recommendation writes.
 *
 * Trigger:
 *   event "ads/landing-page-scout.analyze" { workspaceId, productId? } → gap-analyze captured snapshots
 *
 * See docs/brain/inngest/landing-page-scout.md.
 */
import { inngest } from "./client";
import { analyzeLanderGaps } from "@/lib/landing-page-scout";

export const landingPageScoutAnalyze = inngest.createFunction(
  { id: "landing-page-scout-analyze", retries: 1, triggers: [{ event: "ads/landing-page-scout.analyze" }] },
  async ({ event, step }) => {
    const { workspaceId, productId } = (event.data || {}) as {
      workspaceId?: string;
      productId?: string | null;
    };
    if (!workspaceId) return { skipped: "workspaceId required" };

    const result = await step.run("gap-analysis", () => analyzeLanderGaps(workspaceId, productId ?? null));
    return { workspaceId, productId: productId ?? null, ...result };
  },
);
