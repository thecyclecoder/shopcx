/**
 * Review-candidacy detector cron — Phase 1 of [[../../../docs/brain/specs/review-request-sol-session]].
 *
 * Every 30 min the cron sweeps for tickets that have been quiet for 24h SINCE
 * THE LAST EXTERNAL MESSAGE (not since close, not since creation — see the
 * spec's "Trigger" section for why: median resolution is 0.2h, 82.6% done
 * within 24h, so anchoring on the last message means a fast ticket is asked
 * the next day while a slow thread waits until the conversation is genuinely
 * over). For each qualifying ticket it enqueues ONE `review-candidacy` box job
 * — Sol re-reads the conversation and the customer's recent orders, then
 * emits a typed { ask, product_id, angle, include_coupon, reasoning } verdict.
 * Sol NEVER sends; skipping is always correct when in doubt (nobody is
 * waiting for this message).
 *
 * Node-completeness (CLAUDE.md hard rule):
 *   1. Owner `cs` — registered in [[../control-tower/node-registry]] via the
 *      `BUILDER_WORKER_KINDS` list + this cron's MONITORED_LOOPS row.
 *   2. Kill switch — `enforceSwitch("review-candidacy-detector-cron")` is the
 *      first body statement. A blocked cascade emits a `blocked_off`
 *      heartbeat + returns; the switch resolver's polarity ⇒ missing row = ON.
 *   3. Heartbeat — `emitCronHeartbeat` at the end of every tick, idle or not,
 *      so the CT watchdog can distinguish a healthy idle sweep from a stuck
 *      Inngest schedule.
 *
 * This runs BEFORE the CSAT ask (48h, `ticket-csat-cron`) — the review ask
 * simply lands a day earlier. No change to the CSAT cron is needed here.
 *
 * Cadence + liveness window pinned in [[../control-tower/registry]] (30 min
 * cadence × 1.2 = 36 min minimum; we use 45 min for jitter grace, matching
 * the CSAT cron's shape).
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";

const QUIET_HOURS = 24;
const MAX_AGE_DAYS = 7;
const BATCH_SIZE = 50;

/**
 * Pure predicate — a ticket qualifies for a Sol review-candidacy session when:
 *   - it has at least one message from a customer (an external EXTERNAL author
 *     side means we spoke to a real person, not a bot loop);
 *   - the most recent message from EITHER side landed at least `QUIET_HOURS`
 *     ago (the goodwill is still fresh but the conversation is over);
 *   - the most recent message is not from the customer (the 3.5% "customer
 *     had the last word" tickets are the cheap guard — we owe them a reply
 *     before we ask for a review);
 *   - the ticket isn't older than MAX_AGE_DAYS (asking about a month-old
 *     ticket reads as tone-deaf and hurts sender reputation).
 *
 * Kept pure + exported so the invariant is reviewable in isolation without a
 * DB, mirroring the triage-escalations selection predicates.
 */
export function passesReviewCandidacyWindow(ticket: {
  last_external_at: string | null;
  last_external_direction: "inbound" | "outbound" | null;
  created_at: string | null;
  now: number;
}): boolean {
  if (!ticket.last_external_at) return false;
  if (ticket.last_external_direction !== "outbound") return false;
  const lastAt = Date.parse(ticket.last_external_at);
  if (Number.isNaN(lastAt)) return false;
  const ageMs = ticket.now - lastAt;
  if (ageMs < QUIET_HOURS * 60 * 60 * 1000) return false;
  if (ticket.created_at) {
    const createdAt = Date.parse(ticket.created_at);
    if (
      !Number.isNaN(createdAt) &&
      ticket.now - createdAt > MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    ) {
      return false;
    }
  }
  return true;
}

export const reviewCandidacyDetectorCron = inngest.createFunction(
  {
    id: "review-candidacy-detector-cron",
    name: "Review candidacy detector — 30-min sweep for quiet tickets",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/30 * * * *" }],
  },
  async ({ step }) => {
    // Node-completeness rule #2: enforceSwitch as the FIRST body statement.
    // A blocked cascade returns immediately after writing the blocked_off
    // heartbeat via the resolver so the CT tile renders AMBER instead of RED.
    if ((await enforceSwitch("review-candidacy-detector-cron")).ok === "blocked_off") {
      return { skipped: "blocked_off" };
    }

    const admin = createAdminClient();
    const now = Date.now();
    const quietBefore = new Date(now - QUIET_HOURS * 60 * 60 * 1000).toISOString();
    const notOlderThan = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const result = await step.run("enqueue-review-candidacy-jobs", async () => {
      // Look for tickets whose LAST external message is at least 24h old and
      // whose most recent message was OUTBOUND (we replied last). We fetch
      // candidate tickets by `updated_at` then check the actual last message
      // per-ticket — the ticket row's `updated_at` is a cheap prefilter but
      // not authoritative for who spoke last.
      //
      // `ticket_messages.visibility != 'internal'` filters CS internal notes:
      // the "quiet" window measures the customer-facing conversation only.
      const { data: candidates } = await admin
        .from("tickets")
        .select("id, workspace_id, customer_id, status, created_at, updated_at")
        .not("customer_id", "is", null)
        .not("status", "in", '("archived")')
        .gte("updated_at", notOlderThan)
        .lte("updated_at", quietBefore)
        .order("updated_at", { ascending: true })
        .limit(BATCH_SIZE * 3);
      const rows = (candidates || []) as Array<{
        id: string;
        workspace_id: string;
        customer_id: string | null;
        status: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>;
      if (!rows.length) return { eligible: 0, enqueued: 0, deferred: 0 };

      const ticketIds = rows.map((t) => t.id);

      // For each candidate, find the last EXTERNAL (non-internal) message. The
      // per-ticket read is capped at 3 to bound work — the most recent 3 span
      // enough messages to know whether the last customer-facing turn was
      // outbound, inbound, or absent.
      const { data: msgs } = await admin
        .from("ticket_messages")
        .select("ticket_id, direction, visibility, created_at")
        .in("ticket_id", ticketIds)
        .neq("visibility", "internal")
        .order("created_at", { ascending: false })
        .limit(ticketIds.length * 3);
      const latestExternal = new Map<
        string,
        { at: string; direction: "inbound" | "outbound" | null }
      >();
      for (const m of (msgs || []) as Array<{
        ticket_id: string;
        direction: string | null;
        visibility: string | null;
        created_at: string;
      }>) {
        if (latestExternal.has(m.ticket_id)) continue;
        const dir =
          m.direction === "inbound" || m.direction === "outbound"
            ? (m.direction as "inbound" | "outbound")
            : null;
        latestExternal.set(m.ticket_id, { at: m.created_at, direction: dir });
      }

      // Dedupe against any prior review_requests row for this customer — a
      // customer who has ALREADY been asked in the current window should not
      // be asked again. Cheap coarse guard: if there's ANY row for this
      // (workspace, customer) with sent_at within QUIET_HOURS, skip. Phase 2
      // authors the per-product ladder logic; this cron only protects the
      // "one ask per customer per short window" invariant.
      const customerIds = Array.from(
        new Set(rows.map((t) => t.customer_id).filter((v): v is string => !!v)),
      );
      let recentlyAskedCustomers = new Set<string>();
      if (customerIds.length) {
        const recentAskWindow = new Date(
          now - QUIET_HOURS * 60 * 60 * 1000,
        ).toISOString();
        const { data: recentAsks } = await admin
          .from("review_requests")
          .select("customer_id")
          .in("customer_id", customerIds)
          .gte("sent_at", recentAskWindow);
        recentlyAskedCustomers = new Set(
          ((recentAsks || []) as Array<{ customer_id: string }>).map(
            (r) => r.customer_id,
          ),
        );
      }

      // Dedupe against inflight `review-candidacy` jobs — the box lane's
      // concurrency-1 cap means only one runs at a time; the enqueue guard
      // keeps us from stacking N-1 more behind it.
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("spec_slug")
        .eq("kind", "review-candidacy")
        .in("spec_slug", ticketIds)
        .in("status", [
          "queued",
          "queued_resume",
          "claimed",
          "building",
          "needs_input",
        ]);
      const inflightSlugs = new Set(
        (inflight || []).map((j) => j.spec_slug as string),
      );

      const eligible = rows.filter((t) => {
        if (inflightSlugs.has(t.id)) return false;
        if (t.customer_id && recentlyAskedCustomers.has(t.customer_id)) return false;
        const last = latestExternal.get(t.id);
        return passesReviewCandidacyWindow({
          last_external_at: last?.at ?? null,
          last_external_direction: last?.direction ?? null,
          created_at: t.created_at,
          now,
        });
      });
      const capped = eligible.slice(0, BATCH_SIZE);

      let enqueued = 0;
      for (const t of capped) {
        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: t.workspace_id,
          spec_slug: t.id, // per-ticket dedupe on spec_slug matches ticket-analyze / cs-director-call
          kind: "review-candidacy",
          status: "queued",
          instructions: JSON.stringify({
            ticket_id: t.id,
            workspace_id: t.workspace_id,
            customer_id: t.customer_id,
          }),
          created_by: null,
        });
        if (!error) enqueued++;
      }

      return {
        eligible: eligible.length,
        enqueued,
        deferred: Math.max(0, eligible.length - capped.length),
      };
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("review-candidacy-detector-cron", {
        ok: true,
        produced: result,
      });
    });

    return result;
  },
);
