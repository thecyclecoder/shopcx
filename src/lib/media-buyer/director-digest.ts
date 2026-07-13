/**
 * director-digest — media-buyer-director-slack-digest Phase 2. After each media-buyer pass, the Growth
 * Director (Max) posts ONE digest of the cohort recommendations into the founder's private
 * #director-growth-max channel ([[../../tables/workspaces]] `slack_growth_director_channel_id`).
 *
 * Design (spec constraint): the media-buyer agent ([[./agent]]) NEVER posts to Slack directly — it only
 * writes `<verb>_shadow` [[../../tables/director_activity]] rows. THIS module is the sole delivery path,
 * called by the box worker's media-buyer lane AFTER `runMediaBuyerLoop` returns, so the recommendations
 * are rolled up and voiced by the Director, not the tool. Posts AS Max via `postAsGrowthDirector`
 * (mirrors how Ada posts into #cto-ada). One message per pass; records a `media_buyer_digest_posted`
 * director_activity row for the audit trail.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { MediaBuyerPlan } from "@/lib/media-buyer/agent";
import { getSlackToken, postAsGrowthDirector } from "@/lib/slack";
import { recordDirectorActivity } from "@/lib/director-activity";
import { getPersona } from "@/lib/agents/personas";

type Admin = ReturnType<typeof createAdminClient>;

export interface AccountPlan {
  account: string;
  /** The cohort's product identity — `productTitle` labels the line; null cohorts (legacy Superfood Tabs)
   * fall back to an account-id label. See media-buyer-digest-consolidate-product-names-suppress-noop Phase 1. */
  productId?: string | null;
  productTitle?: string | null;
  plan: MediaBuyerPlan;
}

export interface DigestResult {
  posted: boolean;
  reason?: string;
  ts?: string;
}

/**
 * Resolve `products.title` for the given ids, WORKSPACE-SCOPED. The `products` table has no
 * explicit workspace FK from `media_buyer_test_cohorts` (only `product_id → products(id)`), so a
 * bad cross-workspace cohort row could otherwise leak another tenant's product title into this
 * workspace's Growth Director Slack digest. This helper is the sole path used by the media-buyer
 * lane to resolve titles before it hands the digest AccountPlans off — it hard-narrows every
 * lookup with `.eq("workspace_id", workspaceId)` so an out-of-workspace product silently drops
 * out of the map and the digest line falls back to the `account <id8>` label in `composeDigest`
 * (a mismatched title is NEVER surfaced).
 *
 * media-buyer-digest-consolidate-product-names-suppress-noop Fix 1 — resolves the pre-merge
 * spec-test `sec:authz_rls` finding at scripts/builder-worker.ts:20455.
 *
 * Returns an empty Map when `productIds` is empty; a null-title row is intentionally dropped so
 * the caller's `productTitle ?? null` collapse still routes through the `composeDigest`
 * account-id fallback.
 */
export async function resolveProductTitlesForWorkspace(
  admin: Admin,
  workspaceId: string,
  productIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!productIds.length) return out;
  const { data } = await admin
    .from("products")
    .select("id, title")
    .eq("workspace_id", workspaceId)
    .in("id", productIds);
  for (const p of (data ?? []) as Array<{ id: string; title: string | null }>) {
    if (p.title) out.set(p.id, p.title);
  }
  return out;
}

/** Compose the Growth-Director-voice digest text from the per-account plans. Plain text (director voice).
 * Exported for test coverage of the "label by product" and "suppress no-op" gates. */
export function composeDigest(accountPlans: AccountPlan[]): { text: string; hasRecommendations: boolean } {
  let promote = 0, kill = 0, replenish = 0, fatigue = 0, cohorts = 0;
  const lines: string[] = [];
  for (const { account, productTitle, plan } of accountPlans) {
    if (!plan.policyActive) continue;
    cohorts += 1;
    promote += plan.promote.length;
    kill += plan.kill.length;
    replenish += plan.replenish.length;
    fatigue += plan.fatigueReplenish.length;
    // Label by product title (the founder-legible identifier). Only a product-null cohort
    // (legacy Tabs) keeps the account-id fallback.
    const label = productTitle ? productTitle : `account ${account.slice(0, 8)}`;
    lines.push(`• ${label} — ${plan.summary}`);
  }
  const total = promote + kill + replenish + fatigue;
  const mb = getPersona("media-buyer"); // Bianca 🎯 — the media buyer whose calls this digest relays
  const header = total > 0
    ? `${mb.emoji} ${mb.name} (Media Buyer) — ${promote} to scale, ${kill} to pause, ${replenish} replenish, ${fatigue} refresh across ${cohorts} cohort${cohorts === 1 ? "" : "s"}.`
    : `${mb.emoji} ${mb.name} (Media Buyer) — no changes recommended this cycle across ${cohorts} cohort${cohorts === 1 ? "" : "s"} (all within policy).`;
  return { text: [header, ...lines].join("\n"), hasRecommendations: total > 0 };
}

/**
 * Post the media-buyer digest to the Growth Director channel. Skips (no post) when: no channel configured,
 * Slack not connected, or no account has an active policy (a dormant pass has nothing to report). Returns
 * whether it posted so the caller can log it. Idempotency is by-pass: the worker calls this exactly once
 * after the pass; the recorded `media_buyer_digest_posted` row is the audit anchor.
 */
export async function deliverMediaBuyerDigest(
  admin: Admin,
  workspaceId: string,
  accountPlans: AccountPlan[],
): Promise<DigestResult> {
  const { data: ws } = await admin
    .from("workspaces")
    .select("slack_growth_director_channel_id")
    .eq("id", workspaceId)
    .maybeSingle();
  const channel = (ws as { slack_growth_director_channel_id: string | null } | null)?.slack_growth_director_channel_id;
  if (!channel) return { posted: false, reason: "no slack_growth_director_channel_id configured" };

  // Only report a pass that actually ran a policy — a dormant pass (no active policy / sensor-trust denied)
  // has no cohort recommendations to voice.
  if (!accountPlans.some((p) => p.plan.policyActive)) {
    return { posted: false, reason: "no active policy in any account — dormant pass, nothing to digest" };
  }

  // Suppress no-op posts. `composeDigest` already tallies promote/kill/replenish/fatigue across every
  // active cohort — when the total is zero the digest carries no actionable recommendation, so we skip
  // the post entirely (per media-buyer-digest-consolidate-product-names-suppress-noop Phase 1: don't
  // spam Slack every 2h with "no changes recommended this cycle").
  const { text, hasRecommendations } = composeDigest(accountPlans);
  if (!hasRecommendations) {
    return { posted: false, reason: "no actionable recommendations this pass" };
  }

  const token = await getSlackToken(workspaceId);
  if (!token) return { posted: false, reason: "slack not connected" };

  const post = await postAsGrowthDirector(token, channel, [], text);
  if (!post.ok) return { posted: false, reason: "postAsGrowthDirector failed" };

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "growth",
    actionKind: "media_buyer_digest_posted",
    specSlug: "media-buyer-director-slack-digest",
    reason: "posted media-buyer cohort digest to #director-growth-max",
    metadata: { channel, message_ts: post.ts ?? null, accounts: accountPlans.length, autonomous: true },
  });
  return { posted: true, ts: post.ts };
}
