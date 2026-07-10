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
  plan: MediaBuyerPlan;
}

export interface DigestResult {
  posted: boolean;
  reason?: string;
  ts?: string;
}

/** Compose the Growth-Director-voice digest text from the per-account plans. Plain text (director voice). */
function composeDigest(accountPlans: AccountPlan[]): { text: string; hasRecommendations: boolean } {
  let promote = 0, kill = 0, replenish = 0, fatigue = 0, cohorts = 0;
  const lines: string[] = [];
  for (const { account, plan } of accountPlans) {
    if (!plan.policyActive) continue;
    cohorts += 1;
    promote += plan.promote.length;
    kill += plan.kill.length;
    replenish += plan.replenish.length;
    fatigue += plan.fatigueReplenish.length;
    lines.push(`• account ${account.slice(0, 8)} — ${plan.summary}`);
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

  const token = await getSlackToken(workspaceId);
  if (!token) return { posted: false, reason: "slack not connected" };

  const { text } = composeDigest(accountPlans);
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
