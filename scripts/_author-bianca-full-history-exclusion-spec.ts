/**
 * Authors the sibling M2 exclusion spec: a customer-list custom audience built from our ENTIRE
 * order history (all 3 sources), hashed + refreshed, composed into the SAME
 * targeting.excluded_custom_audiences list as the 180d pixel audience. Founder-directed
 * 2026-07-15 ("we can also submit a custom audience ... taking our entire order history for
 * more complete coverage ... and keep it refreshed"). Owner=growth, Bianca goal M2 milestone.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { upsertSpec } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "bianca-full-order-history-customer-list-exclusion-audience";
const M2_MILESTONE = "703bdab6-9e9e-44a4-945a-4950e23ca602"; // Bianca goal M2 — Purchaser hygiene

async function main() {
  const res = await upsertSpec(
    WS,
    {
      slug: SLUG,
      title: "Full-order-history customer-list exclusion audience (all sources, hashed, refreshed)",
      summary:
        "**Brain refs:** [[../libraries/meta-ads]] · [[../libraries/provision-cohort]] · [[../libraries/media-buyer-publish-gate]] · [[../tables/customers]] · [[../tables/media_buyer_test_cohorts]]\n\nThe second of two cold-test exclusion audiences (sibling to [[bianca-cold-test-recent-purchaser-exclusion]], which ships the 180d pixel audience + the shared excluded_custom_audiences plumbing). The 180d pixel audience can only see Meta-tracked purchasers in the last 180 days; this uploads a CUSTOMER_LIST custom audience from our ENTIRE order history across all three sources (Shopify, Internal, Amazon) — hashed email/phone, no plaintext PII — for complete existing-customer coverage, and keeps it current via a refresh cron. Both audience ids compose into the same targeting.excluded_custom_audiences on every cold-test adset.",
      owner: "growth",
      parent: "[[../goals/bianca-temperature-aware-campaign-structure]] › M2 — Purchaser hygiene",
      parent_kind: "milestone",
      parent_ref: M2_MILESTONE,
      blocked_by: ["bianca-cold-test-recent-purchaser-exclusion"],
      priority: null,
      deferred: false,
      intended_status: "planned",
      intended_status_set_by: "ceo:dylan",
      auto_build: true,
      milestone_id: M2_MILESTONE,
      related_spec: "bianca-cold-test-recent-purchaser-exclusion",
      why:
        "A pixel purchase audience caps at 180 days and only sees Meta-tracked purchases — it misses customers who bought >180d ago, bought on Amazon/internal, or whom the pixel never matched. Those are still existing customers we should not spend cold-prospecting budget re-converting (the false-crown risk the goal names). A customer-list custom audience built from our full order history gives complete coverage, but only if it's kept refreshed as new customers order — a stale list silently narrows the exclusion.",
      what:
        "Adds a getOrCreateAllCustomersAudience helper (CUSTOMER_LIST subtype) + a hashed uploader that enumerates every customer who has ever ordered (all 3 sources) from the customers table, SHA256-hashes normalized email + E.164 phone (no plaintext leaves the box), and uploads in chunks via the Meta customaudience users endpoint. Stores its id in a new media_buyer_test_cohorts.excluded_all_customers_audience_id column, composes BOTH audience ids (180d pixel + all-customers) into targeting.excluded_custom_audiences through the sibling spec's provision/replenish/publish-gate plumbing, and adds a weekly refresh cron (with the full node-completeness trio) that tops up newly-acquired customers so the list never goes stale.",
    },
    [
      {
        position: 1,
        title: "Phase 1 — CUSTOMER_LIST audience builder + hashed uploader + schema column",
        status: "planned",
        body:
          "Create the all-customers audience and upload our full customer base hashed. Enumerate distinct customers who have ordered (customers.total_orders >= 1 / first_order_at not null — this already reflects all 3 sources), hash email (lowercase-trim → SHA256) + phone (E.164 → SHA256), and upload in ≤10k-row chunks via POST /{audience_id}/users with schema ['EMAIL_SHA256','PHONE_SHA256']. No plaintext PII persisted or logged.",
        why:
          "There is no CUSTOMER_LIST audience capability today (the sibling spec only builds a pixel WEBSITE audience). A full-history exclusion needs a find-or-create CUSTOMER_LIST audience, a compliant hashed uploader, and a column to persist the id — mirroring the sibling's excluded_purchaser_audience_id pattern.",
        what:
          "src/lib/meta-ads.ts gains getOrCreateAllCustomersAudience(token, accountId, opts?) (subtype='CUSTOMER_LIST', customer_file_source='USER_PROVIDED_ONLY', found by name) and addUsersToCustomAudience(token, audienceId, rows) that chunk-uploads SHA256(email)+SHA256(phone) payloads. A migration adds media_buyer_test_cohorts.excluded_all_customers_audience_id text (nullable). Brain: meta-ads.md exports + media_buyer_test_cohorts.md column row (bare Meta id, all-sources, hashed-only gotcha).",
        verification:
          "vitest: getOrCreateAllCustomersAudience + addUsersToCustomAudience exported; the uploader emits SHA256 hex (never plaintext) and chunks >10k rows; the migration adds excluded_all_customers_audience_id as nullable text. `npx tsc --noEmit` clean. A unit test pins that a known email/phone hashes to the expected SHA256 after normalization.",
      },
      {
        position: 2,
        title: "Phase 2 — compose the second audience id into the exclusion list + gate + backfill",
        status: "planned",
        body:
          "Reuse the sibling spec's list-shaped plumbing so BOTH ids are excluded on every cold-test adset. The excludedCustomAudienceIds path is already string[]; this adds the second id and extends the publish-gate + backfill to require both.",
        why:
          "The uploaded audience has no effect unless its id flows into every adset alongside the pixel audience, and a hand-edited template must not silently drop it — the same supervisable-autonomy rail the pixel exclusion uses must cover both.",
        what:
          "provisionProductTestCohort / buildReplenishJobInsert compose [excluded_purchaser_audience_id, excluded_all_customers_audience_id].filter(Boolean) into targeting.excluded_custom_audiences. The publish-gate's missing_purchaser_exclusion check is extended (or a sibling missing_customer_exclusion reason added) so a cohort declaring excluded_all_customers_audience_id refuses+escalates a publish that omits it. An idempotent backfill stamps the id + composes it into live cohorts' adset_template via compare-and-set.",
        verification:
          "vitest: provision/replenish emit BOTH ids in excluded_custom_audiences when the cohort declares both; the publish-gate refuses a request missing the all-customers id and allows one that includes it; the backfill defaults to dry-run + compare-and-set. `npm run test:media-buyer-agent` + publish-gate pins green.",
      },
      {
        position: 3,
        title: "Phase 3 — weekly refresh cron (keep the list current) + node-completeness trio",
        status: "planned",
        body:
          "A CUSTOMER_LIST audience doesn't auto-update — new customers must be uploaded as they order, or the exclusion silently narrows. A weekly cron tops up customers acquired since the last run.",
        why:
          "Without a refresh, the all-customers list is a point-in-time snapshot: every new customer acquired after the initial upload is NOT excluded, so the exclusion decays exactly as the business grows. A bounded weekly top-up keeps coverage complete.",
        what:
          "Add a weekly Inngest cron that uploads customers with first_order_at (or updated order history) since the last successful refresh to each account's all-customers audience (incremental, hashed). Ship the node-completeness trio: an OWNER in the node registry (Growth/Bianca), a kill_switches ancestry, and an end-of-run emitCronHeartbeat. Register it in MONITORED_LOOPS with expectedCadence 'weekly' and a ≥9d livenessWindowMs (per the monitor-cadence invariant); no sub-5-min cadence.",
        verification:
          "vitest: the refresh selects only customers since the last-refresh watermark; the new node passes `npm run check:node-registry-drift` (owned + switched + heartbeated) and assertRegistryInvariants (weekly cadence, ≥9d window). `npx vitest run` green, `npx tsc --noEmit` clean.",
      },
    ],
  );
  console.log("sibling spec authored:", res.spec_id, "phases:", JSON.stringify(res.phase_ids));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
