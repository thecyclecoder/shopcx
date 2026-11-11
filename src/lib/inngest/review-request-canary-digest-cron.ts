/**
 * Review-request canary digest cron — Phase 3 of review-request-sol-session,
 * amended by review-request-digest-not-a-ceo-card.
 *
 * ORIGINAL intent: hold each draft with a LONG pending_send_at (12-24h) while
 * the canary flag is on, and raise ONE digest card per batch so the founder
 * could cancel or edit a wrong ask before the outbox shipped it.
 *
 * AMENDED (founder 2026-11-11 — "no more review request drafts.. I don't think
 * we need those as ceo cards anymore"): the drafts keep sending on their own
 * schedule regardless, so the digest is a pure FYI that needs no decision. An
 * FYI does not belong in the CEO approvals inbox. This cron NO LONGER inserts a
 * CEO-routed `agent_approval_request` `dashboard_notifications` row. Instead it
 * records ONE non-approval `director_activity` ledger row per workspace-day
 * under the review-request owner (`cs`) — a surfacing row that shows up in the
 * owner's activity feed / EOD recap but never counts toward the CEO approvals
 * feed.
 *
 * It still runs once a day at 08:00 UTC and sweeps the last 24h of drafts whose
 * canary hold hasn't yet fired. Dedupe key is
 * `review_request_canary_digest:<workspace_id>:<yyyy-mm-dd>` so a re-run on the
 * same day is a no-op.
 *
 * Node-completeness (CLAUDE.md hard rule):
 *   1. Owner `cs` (Sol reports to June) — registered in
 *      [[../control-tower/node-registry]] via MONITORED_LOOPS.
 *   2. `enforceSwitch("review-request-canary-digest-cron")` first body
 *      statement.
 *   3. `emitCronHeartbeat` at end of every tick.
 *
 * The canary flag is a config gate — when off, this cron's inner work
 * short-circuits (holdMs drops to the normal response delay in the
 * delivery SDK) and no drafts land in the window ⇒ no digest row.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";
import { recordDirectorActivity } from "@/lib/director-activity";

/** Non-approval director_activity action kind — an FYI ledger row, never a CEO card. */
const REVIEW_CANARY_DIGEST_ACTION_KIND = "review_request_canary_digest";
/** The function slug whose objective owns this cron (Sol reports to June). */
const REVIEW_CANARY_OWNER_FUNCTION = "cs";

/** Format `YYYY-MM-DD` from a Date (UTC) — pure so the dedupe key is stable. */
export function reviewCanaryDigestDedupeKey(
  workspaceId: string,
  now: Date,
): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `review_request_canary_digest:${workspaceId}:${y}-${m}-${d}`;
}

/** Human-readable digest body — pure so a unit test can pin the shape. */
export function composeReviewCanaryDigestBody(input: {
  count: number;
  earliestSendAt: string | null;
  ticketLinks: string[];
}): string {
  const count = Math.max(0, Math.trunc(input.count));
  const noun = count === 1 ? "review request" : "review requests";
  const when = input.earliestSendAt
    ? `sending starts ${input.earliestSendAt}`
    : "sending window pending";
  const lines: string[] = [
    `📬 ${count} ${noun} drafted — ${when}. Open each ticket to cancel or edit before it ships.`,
    "",
    ...input.ticketLinks.slice(0, 20).map((l) => `- ${l}`),
  ];
  return lines.join("\n");
}

export const reviewRequestCanaryDigestCron = inngest.createFunction(
  {
    id: "review-request-canary-digest-cron",
    name: "Review-request canary — daily CEO-inbox digest",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 8 * * *" }],
  },
  async ({ step }) => {
    if (
      (await enforceSwitch("review-request-canary-digest-cron")).ok ===
      "blocked_off"
    ) {
      return { skipped: "blocked_off" };
    }

    const admin = createAdminClient();
    const now = new Date();
    const nowMs = now.getTime();
    const windowStart = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

    const result = await step.run("raise-digests", async () => {
      const { data: drafts } = await admin
        .from("review_message_drafts")
        .select("id, workspace_id, ticket_id, created_at")
        .eq("outcome", "drafted")
        .gte("created_at", windowStart)
        .order("created_at", { ascending: true })
        .limit(500);
      const rows = (drafts || []) as Array<{
        id: string;
        workspace_id: string;
        ticket_id: string | null;
        created_at: string;
      }>;
      if (!rows.length) return { workspaces: 0, digests: 0, drafts: 0 };

      const byWorkspace = new Map<
        string,
        Array<{ ticket_id: string | null; created_at: string }>
      >();
      for (const r of rows) {
        if (!byWorkspace.has(r.workspace_id)) {
          byWorkspace.set(r.workspace_id, []);
        }
        byWorkspace.get(r.workspace_id)!.push({
          ticket_id: r.ticket_id,
          created_at: r.created_at,
        });
      }

      let digests = 0;
      for (const [workspaceId, drafts] of byWorkspace) {
        const dedupeKey = reviewCanaryDigestDedupeKey(workspaceId, now);
        // Confirming predicate — never enumerate-then-record without
        // re-asserting the "not yet logged today" state. Dedupe against the
        // director_activity ledger (the CEO card is gone per founder
        // 2026-11-11), keyed by the same stable per-(workspace,day) key.
        const { data: prior } = await admin
          .from("director_activity")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("action_kind", REVIEW_CANARY_DIGEST_ACTION_KIND)
          .eq("metadata->>dedupe_key", dedupeKey)
          .limit(1);
        if ((prior ?? []).length > 0) continue;

        const earliest = drafts.reduce<string | null>((acc, d) => {
          if (!acc) return d.created_at;
          return d.created_at < acc ? d.created_at : acc;
        }, null);
        const ticketLinks = drafts
          .map((d) =>
            d.ticket_id ? `/dashboard/tickets/${d.ticket_id}` : "(no ticket)",
          )
          .filter(Boolean);
        const body = composeReviewCanaryDigestBody({
          count: drafts.length,
          earliestSendAt: earliest,
          ticketLinks,
        });

        // FYI ledger row under the review-request owner — NOT a CEO approval
        // card. recordDirectorActivity is best-effort + never throws.
        const { recorded } = await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: REVIEW_CANARY_OWNER_FUNCTION,
          actionKind: REVIEW_CANARY_DIGEST_ACTION_KIND,
          reason: body,
          metadata: {
            dedupe_key: dedupeKey,
            draft_count: drafts.length,
            earliest_send_at: earliest,
          },
        });
        if (recorded) digests++;
      }

      return {
        workspaces: byWorkspace.size,
        digests,
        drafts: rows.length,
      };
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("review-request-canary-digest-cron", {
        ok: true,
        produced: result,
      });
    });

    return result;
  },
);
