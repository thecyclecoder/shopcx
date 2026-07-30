import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const ok = await authorSpecRowStructured(
    WS,
    "media-buyer-digest-consolidate-product-names-suppress-noop",
    {
      title: "Bianca's Slack digest — product names, ONE consolidated message, suppress no-op noise",
      why: "The #director-growth-max media-buyer digest is noisy and unreadable on three counts: (1) it labels each line by a truncated ad-account id (`account 2352876…`) instead of the PRODUCT, so the founder can't tell which product a recommendation is about — and shared accounts (Amazing Coffee + Creamer) collapse to the same 8-char prefix; (2) the cadence dispatcher (src/lib/inngest/media-buyer-cadence.ts) inserts ONE `kind='media-buyer'` agent_jobs row PER active cohort, and each job's box-worker lane (scripts/builder-worker.ts ~L20444) calls deliverMediaBuyerDigest once → the founder gets one Slack message PER COHORT per pass (up to 6 now that cohorts are per-product), not one digest; (3) deliverMediaBuyerDigest posts even when nothing is actionable — composeDigest already computes `hasRecommendations` but the caller ignores it and posts the '…no changes recommended this cycle…' line every 2h.",
      what: "One consolidated digest per workspace per pass, lines labelled by product title, and no post when there's nothing to act on.",
      summary: "Fix three defects in src/lib/media-buyer/director-digest.ts + its dispatch: label by product (resolve cohort product_id→products.title), roll every account×product cohort into ONE message per workspace per pass, and skip the post when `hasRecommendations` is false.",
      owner: "growth",
      parent: '[[../functions/growth]] — "Media buyer (Bianca, under Max)" mandate: Bianca\'s pass is voiced up to Max via this digest; a per-cohort-spammy, account-id-labelled, no-op-noisy digest breaks the supervisor\'s read of her calls. See [[../libraries/media-buyer-director-digest]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Suppress no-op posts + label lines by product",
          why: "The two smallest, highest-signal fixes: stop posting empty passes, and make each surviving line name the product instead of a truncated account id.",
          what: "Gate the post on hasRecommendations, and resolve each plan's cohort product_id → products.title for the line label (fall back to account id only when a cohort is product-null, e.g. legacy Tabs).",
          body: "In src/lib/media-buyer/director-digest.ts: (1) `deliverMediaBuyerDigest` already gets `{ text, hasRecommendations }` from composeDigest — return `{ posted:false, reason:'no actionable recommendations this pass' }` WITHOUT posting when `!hasRecommendations` (keep posting when there IS something to scale/pause/replenish/refresh). (2) Thread the cohort's product identity into AccountPlan (add `productId`/`productTitle`, or resolve it in composeDigest from media_buyer_test_cohorts→products.title) so each line reads `• {ProductTitle} — {summary}` instead of `• account {id8} — …`; a product-null cohort keeps an account label. Update docs/brain/libraries/media-buyer-director-digest.md in the same PR per CLAUDE.md.",
          verification: "- tsc clean\n- the digest skips posting when there are no recommendations (hasRecommendations gate wired)\n- lines are labelled by product title, not a truncated account id",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the no-op post is suppressed (hasRecommendations gates the post)", kind: "auto", exec_kind: "grep", params: { pattern: "hasRecommendations", path: "src/lib/media-buyer/director-digest.ts", expect: "present" } },
            { position: 3, description: "the account-id line label is gone (no `account ${…slice}` label)", kind: "auto", exec_kind: "grep", params: { pattern: "account \\$\\{account.slice", path: "src/lib/media-buyer/director-digest.ts", expect: "absent" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — ONE consolidated digest per workspace per pass",
          why: "One Slack message per cohort per pass is the core noise source; the founder wants a single rolled-up digest.",
          what: "Ensure the digest is delivered exactly once per workspace per cadence pass, rolling up every account×product cohort — not one message per media-buyer job.",
          body: "The box-worker media-buyer lane (scripts/builder-worker.ts, runMediaBuyerLane) already fans out over ALL accountIds × products within a single job and posts one digest. The multiplicity comes from the DISPATCHER (src/lib/inngest/media-buyer-cadence.ts) enqueuing one `kind='media-buyer'` job PER cohort row. Fix so the digest lands ONCE per workspace per pass: either (a) enqueue ONE workspace-scoped media-buyer job per pass (the lane's account×product fan-out already covers every cohort — the per-cohort job split is now redundant), or (b) keep per-cohort jobs but move digest delivery to a single post-pass rollup keyed on (workspace, cadence-slot) so only the last job posts. Prefer (a): it also removes the redundant re-fan-out. Preserve the dormant-heartbeat guarantee (a workspace with no active cohort still runs one pass so the audit row lands). Update docs/brain/inngest/media-buyer-cadence.md + docs/brain/libraries/media-buyer-director-digest.md in the same PR per CLAUDE.md.",
          verification: "- tsc clean\n- exactly one media-buyer digest is delivered per workspace per pass (dispatch enqueues one workspace-scoped job, or delivery is deduped per cadence-slot)\n- the dormant-heartbeat pass is preserved",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "media-buyer agent unit tests still green (fan-out + dispatch shape pinned)", kind: "auto", exec_kind: "unit_test", params: { script: "test:media-buyer-agent" } },
            { position: 3, description: "founder confirms exactly one consolidated digest per pass in #director-growth-max", kind: "human", exec_kind: "needs_human", params: null },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#media-buyer-bianca-under-max" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
