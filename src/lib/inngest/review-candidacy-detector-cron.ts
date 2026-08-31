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
/**
 * Read prefilter — how many candidate rows the SQL sweep pulls back before the
 * eligibility filters (last-external direction, inflight dedup, verdict
 * cooldown) narrow the set. Kept wide so that a tick with many recently-
 * ineligible rows (customer had the last word, prior verdict on file) still
 * surfaces enough fresh candidates to fill the enqueue cap.
 */
export const REVIEW_CANDIDACY_READ_PREFILTER = 150;
/**
 * Enqueue cap per tick — bounded to the size of the concurrency-1 Sol
 * `review-candidacy` lane so the producer matches the consumer's throughput.
 * A Sol session takes minutes; the box drains one at a time; 30 min between
 * ticks means only a handful can realistically complete before we sweep again.
 * A cap of 5 lets the lane clear (or nearly clear) before the next tick adds
 * more, keeping the Control Tower's stuck-lane threshold reflective of real
 * worker failure instead of detector backpressure. The remainder defers to
 * the next tick.
 */
export const REVIEW_CANDIDACY_ENQUEUE_CAP = 5;
/**
 * Verdict cooldown — how far back the recent-job lookup scans for
 * `review-candidacy` `agent_jobs` rows in the terminal statuses (completed,
 * failed, needs_attention). A ticket that already produced a verdict in this
 * window is suppressed, so the same quiet thread is not reconsidered every
 * half hour after Sol has spoken. Sized at 2× MAX_AGE_DAYS so any ticket that
 * would still fall inside the 7-day eligibility window is covered with a full
 * doubling of margin.
 */
export const REVIEW_CANDIDACY_VERDICT_COOLDOWN_HOURS = MAX_AGE_DAYS * 24 * 2;

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

export type ReviewCandidacyBatchRow = {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  created_at: string | null;
};

/**
 * Pure batch selector — takes the prefiltered candidate rows plus the
 * lookup maps that the cron's step assembled from `ticket_messages`,
 * `review_requests`, and `agent_jobs`, then applies:
 *   1. inflight-job dedup;
 *   2. recent per-customer ask dedup (Phase 1's coarse guard);
 *   3. the quiet-outbound window predicate ([[passesReviewCandidacyWindow]]);
 *   4. **recent-verdict cooldown skip** — the fix Phase 1 of the
 *      review-candidacy-detector-lane-backpressure-and-completed-verdict-cooldown
 *      spec exists to add; a ticket whose id appears in `recentVerdictSlugs`
 *      is dropped and counted separately so operators can see when the
 *      detector is suppressing repeats vs. silently doing nothing.
 *   5. **enqueue-cap slice** — bounds the returned `capped` set to
 *      `REVIEW_CANDIDACY_ENQUEUE_CAP` so the producer matches the
 *      concurrency-1 Sol lane's throughput; overflow reports as `deferred`.
 *
 * Kept pure + exported so both invariants are reviewable in isolation
 * without a DB, mirroring the triage-escalations selection tests.
 */
export function selectReviewCandidacyBatch(input: {
  rows: ReviewCandidacyBatchRow[];
  latestExternal: Map<
    string,
    { at: string; direction: "inbound" | "outbound" | null }
  >;
  inflightSlugs: Set<string>;
  recentlyAskedCustomers: Set<string>;
  recentVerdictSlugs: Set<string>;
  /**
   * Tickets that carry BOTH an external inbound (the customer wrote) and an
   * external outbound (we answered). A ticket missing either side is not a
   * conversation and must never reach Sol.
   *
   * Without this, an automated dunning ticket — one outbound payment-recovery
   * notice, zero customer replies — passes the "we spoke last" window check
   * and burns a full Sol session to conclude there was nothing to conclude.
   * Observed live: Sol's own verdict read "with AI turns=0 she hasn't even
   * responded, so there is no finished conversation". Same class as the CSAT
   * cron's "only survey tickets we actually answered" guard, applied to both
   * directions instead of one.
   *
   * This is deliberately a general rule rather than a dunning-specific tag
   * match — it also excludes auto-replies, shipping notices, OOF bounces, and
   * any future one-sided ticket type nobody thought to enumerate.
   */
  twoSidedTicketIds: Set<string>;
  now: number;
  enqueueCap: number;
}): {
  eligible: ReviewCandidacyBatchRow[];
  capped: ReviewCandidacyBatchRow[];
  deferred: number;
  skipped_recent_verdict: number;
  skipped_one_sided: number;
} {
  let skipped_recent_verdict = 0;
  let skipped_one_sided = 0;
  const eligible = input.rows.filter((t) => {
    if (input.inflightSlugs.has(t.id)) return false;
    // Both sides must have spoken. Cheapest discriminator available, and it
    // runs before the window check so one-sided tickets cost nothing.
    if (!input.twoSidedTicketIds.has(t.id)) {
      skipped_one_sided++;
      return false;
    }
    if (t.customer_id && input.recentlyAskedCustomers.has(t.customer_id))
      return false;
    const last = input.latestExternal.get(t.id);
    const passesWindow = passesReviewCandidacyWindow({
      last_external_at: last?.at ?? null,
      last_external_direction: last?.direction ?? null,
      created_at: t.created_at,
      now: input.now,
    });
    if (!passesWindow) return false;
    if (input.recentVerdictSlugs.has(t.id)) {
      skipped_recent_verdict++;
      return false;
    }
    return true;
  });
  const capped = eligible.slice(0, input.enqueueCap);
  return {
    eligible,
    capped,
    deferred: Math.max(0, eligible.length - capped.length),
    skipped_recent_verdict,
    skipped_one_sided,
  };
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
        .limit(REVIEW_CANDIDACY_READ_PREFILTER);
      const rows = (candidates || []) as Array<{
        id: string;
        workspace_id: string;
        customer_id: string | null;
        status: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>;
      if (!rows.length)
        return {
          eligible: 0,
          enqueued: 0,
          deferred: 0,
          skipped_recent_verdict: 0,
        };

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

      // A ticket only qualifies if BOTH sides actually spoke. `latestExternal`
      // above answers "who spoke LAST", which a one-sided automated ticket
      // (dunning notice, auto-reply, shipping update) passes trivially — it
      // has an outbound and nothing else. Read the two directions separately
      // rather than reusing the 3-most-recent-per-ticket window above, which
      // could miss an inbound behind three recent outbounds.
      const twoSidedTicketIds = new Set<string>();
      {
        const [{ data: inboundRows }, { data: outboundRows }] = await Promise.all([
          admin
            .from("ticket_messages")
            .select("ticket_id")
            .in("ticket_id", ticketIds)
            .neq("visibility", "internal")
            .eq("direction", "inbound"),
          admin
            .from("ticket_messages")
            .select("ticket_id")
            .in("ticket_id", ticketIds)
            .neq("visibility", "internal")
            .eq("direction", "outbound"),
        ]);
        const withInbound = new Set(
          ((inboundRows || []) as Array<{ ticket_id: string }>).map((m) => m.ticket_id),
        );
        for (const m of (outboundRows || []) as Array<{ ticket_id: string }>) {
          if (withInbound.has(m.ticket_id)) twoSidedTicketIds.add(m.ticket_id);
        }
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

      // Dedupe against RECENT TERMINAL `review-candidacy` verdicts — a ticket
      // that already produced a completed / failed / needs_attention job
      // inside the verdict-cooldown window must NOT be re-enqueued on the
      // next tick (before this filter, a quiet outbound ticket that Sol has
      // already reviewed once was reconsidered every 30 min for its remaining
      // 7-day eligibility, filling the concurrency-1 lane with repeat work).
      // Phase 1 does not persist a `review_requests` ledger row on Sol's
      // verdict, so the agent_jobs row IS the fingerprint. The window is
      // sized at 2× MAX_AGE_DAYS so any still-eligible ticket is covered.
      const verdictCooldownStart = new Date(
        now - REVIEW_CANDIDACY_VERDICT_COOLDOWN_HOURS * 60 * 60 * 1000,
      ).toISOString();
      const { data: recentVerdicts } = await admin
        .from("agent_jobs")
        .select("spec_slug")
        .eq("kind", "review-candidacy")
        .in("spec_slug", ticketIds)
        .in("status", ["completed", "failed", "needs_attention"])
        .gte("created_at", verdictCooldownStart);
      const recentVerdictSlugs = new Set(
        (recentVerdicts || []).map((j) => j.spec_slug as string),
      );

      const {
        eligible,
        capped,
        deferred,
        skipped_recent_verdict,
        skipped_one_sided,
      } = selectReviewCandidacyBatch({
        rows,
        latestExternal,
        inflightSlugs,
        recentlyAskedCustomers,
        recentVerdictSlugs,
        twoSidedTicketIds,
        now,
        enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
      });

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
        deferred,
        skipped_recent_verdict,
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
