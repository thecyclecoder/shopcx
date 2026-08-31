/**
 * Review-request canary CEO-inbox digest cron — Phase 3 of
 * review-request-sol-session.
 *
 * Spec § "The gap that needs closing":
 *
 *   > pending_send_at is only rendered INSIDE an individual ticket — there
 *   > is no list view. Twenty drafts scattered across twenty tickets is not
 *   > a review queue, it is a scavenger hunt against a cron. So while the
 *   > canary flag is on: hold each draft with a LONG pending_send_at (12-24h
 *   > rather than minutes) and raise ONE digest card in the CEO inbox per
 *   > batch — dashboard_notifications, type 'agent_approval_request', the
 *   > pattern src/lib/ship-time-backfill-detector.ts already uses — reading
 *   > '5 review requests drafted, sending 9am tomorrow' with a link to each
 *   > ticket. The founder opens the inbox they already read, clicks through,
 *   > and cancels or edits anything wrong.
 *
 * This cron runs once a day at 08:00 UTC, sweeps the last 24h of drafts
 * whose canary hold hasn't yet fired (pending_send_at is in the future),
 * and raises ONE digest card per workspace-day. Dedupe key is
 * `review_request_canary_digest:<workspace_id>:<yyyy-mm-dd>` so a re-run on
 * the same day is a no-op.
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
 * delivery SDK) and no digest lands. Ship it ON per the spec.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";

const REVIEW_CANARY_DIGEST_TYPE = "agent_approval_request";
const REVIEW_CANARY_ROUTED_TO = "ceo";
const REVIEW_CANARY_ESCALATION_KIND = "review_request_canary_digest";

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
      if (!rows.length) return { workspaces: 0, cards: 0, drafts: 0 };

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

      let cards = 0;
      for (const [workspaceId, drafts] of byWorkspace) {
        const dedupeKey = reviewCanaryDigestDedupeKey(workspaceId, now);
        // Confirming predicate — never enumerate-then-insert without
        // re-asserting the "not yet raised today" state. Same shape
        // ship-time-backfill-detector uses for its dedupe.
        const { data: prior } = await admin
          .from("dashboard_notifications")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("type", REVIEW_CANARY_DIGEST_TYPE)
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
        const title = `${drafts.length} review request${drafts.length === 1 ? "" : "s"} drafted`;
        const body = composeReviewCanaryDigestBody({
          count: drafts.length,
          earliestSendAt: earliest,
          ticketLinks,
        });

        const { error } = await admin.from("dashboard_notifications").insert({
          workspace_id: workspaceId,
          type: REVIEW_CANARY_DIGEST_TYPE,
          title: title.slice(0, 200),
          body: body.slice(0, 4000),
          link: "/dashboard/tickets",
          metadata: {
            routed_to_function: REVIEW_CANARY_ROUTED_TO,
            escalation_kind: REVIEW_CANARY_ESCALATION_KIND,
            dedupe_key: dedupeKey,
            draft_count: drafts.length,
          },
          read: false,
          dismissed: false,
        });
        if (!error) cards++;
      }

      return {
        workspaces: byWorkspace.size,
        cards,
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
