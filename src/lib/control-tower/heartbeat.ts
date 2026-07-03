/**
 * Control Tower — heartbeat emit helper (control-tower spec, Phase 1).
 *
 * Every monitored cron + box agent-kind runner calls this at the END of each run
 * to write ONE loop_heartbeats row. The control-tower-monitor cron reads the
 * latest beat per loop_id to decide liveness / freshness; the dashboard reads
 * recent beats for the per-loop history.
 *
 * BEST-EFFORT: a heartbeat write must never break (or fail) the loop it reports
 * on — every error is swallowed and logged. Crons wrap this in a step.run so a
 * transient DB hiccup doesn't fail the function; the box worker calls its own
 * inline writer (scripts/builder-worker.ts) against its existing admin client.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  agentLoopId,
  RENEWAL_OUTCOME_LOOP_ID,
  type LoopKind,
  type RenewalOutcome,
} from "@/lib/control-tower/registry";

export interface HeartbeatInput {
  /** false ⇒ the run threw or reported a failure. Default true. */
  ok?: boolean;
  /** what the run produced (counts/summary) — stored as jsonb. */
  produced?: unknown;
  detail?: string;
  durationMs?: number;
}

/**
 * In-memory ≤1/min-per-loop coalesce. Liveness only needs "this loop ran recently",
 * so at most one beat per loop_id per minute is plenty (even 1/min is fine). Without
 * this, per-EVENT emitters (a beat per ticket analyzed / order fraud-checked / journey
 * delivered / renewal) each fire a PostgREST INSERT on every event — pure egress waste.
 * This collapses that flood to one write per loop per minute.
 *
 * Two carve-outs so we never lose signal:
 *   - ok:false beats ALWAYS write — the error-rate + liveness-when-work-exists assertions
 *     must see every failure.
 *   - Aggregation channels (RENEWAL_OUTCOME_LOOP_ID) ALWAYS write — each beat is a COUNTED
 *     record (outcome distribution), not a liveness ping; coalescing would corrupt the counts.
 *
 * Best-effort, like the rest of this module. The map is bounded (one entry per loop_id, and
 * loop_ids are a finite registered set). On a fresh process the first beat per loop always
 * writes (liveness is fresh on boot). Per-process: on serverless this coalesces within a warm
 * instance; across instances you get at most ~1/min each — still an orders-of-magnitude cut.
 */
const HEARTBEAT_COALESCE_MS = 60_000;
const lastBeatAt = new Map<string, number>();
/** loop_ids whose beats are AGGREGATED (counted), not liveness — never coalesced. */
const NEVER_COALESCE = new Set<string>([RENEWAL_OUTCOME_LOOP_ID]);

export async function emitLoopHeartbeat(
  loopId: string,
  kind: LoopKind,
  input: HeartbeatInput = {},
): Promise<void> {
  const ok = input.ok ?? true;
  const now = Date.now();
  // Coalesce successful liveness beats to ≤1/min per loop. Failures + aggregation channels
  // always fall through to a write.
  if (ok && !NEVER_COALESCE.has(loopId)) {
    const last = lastBeatAt.get(loopId);
    if (last !== undefined && now - last < HEARTBEAT_COALESCE_MS) return;
  }
  lastBeatAt.set(loopId, now);
  try {
    const admin = createAdminClient();
    await admin.from("loop_heartbeats").insert({
      loop_id: loopId,
      kind,
      ok,
      produced: input.produced ?? null,
      detail: input.detail ?? null,
      duration_ms: input.durationMs ?? null,
      ran_at: new Date(now).toISOString(),
    });
  } catch (e) {
    console.warn(`[control-tower] heartbeat write failed for ${loopId}:`, e instanceof Error ? e.message : e);
  }
}

/** Convenience: emit a cron's end-of-run beat (loop_id = the inngest function id). */
export function emitCronHeartbeat(functionId: string, input: HeartbeatInput = {}): Promise<void> {
  return emitLoopHeartbeat(functionId, "cron", input);
}

/** Convenience: emit a box agent-kind end-of-run beat (loop_id = `agent:<kind>`). */
export function emitAgentHeartbeat(agentKind: string, input: HeartbeatInput = {}): Promise<void> {
  return emitLoopHeartbeat(agentLoopId(agentKind), "agent-kind", input);
}

/**
 * Convenience: emit an inline event-driven AI agent's end-of-run beat (loop_id = `ai:<agent>`,
 * e.g. INLINE_AGENT_IDS.ticketAnalyzer). Call from a try/finally so a thrown run still beats
 * with ok:false — that's what the error-rate + liveness-when-work-exists assertions read.
 */
export function emitInlineAgentHeartbeat(agentId: string, input: HeartbeatInput = {}): Promise<void> {
  return emitLoopHeartbeat(agentId, "inline-agent", input);
}

/**
 * Convenience: emit a reactive event-driven Inngest agent's end-of-run beat (loop_id = the
 * inngest function id, e.g. "unified-ticket-handler"). Call from an end-of-run try/finally so a
 * thrown run still beats with ok:false — that's what the error-rate + liveness-when-work-exists
 * assertions read. (control-tower-complete-coverage spec, Phase 1.)
 */
export function emitReactiveHeartbeat(functionId: string, input: HeartbeatInput = {}): Promise<void> {
  return emitLoopHeartbeat(functionId, "reactive", input);
}

/**
 * Convenience: record ONE per-sub renewal outcome beat (control-tower-renewal-integrity-assertions,
 * Phase 1). Called from every terminal path of `internal-subscription-renewal-attempt` so the
 * Control Tower outcome-distribution assertion can aggregate the per-cycle mix — the only uniform
 * channel that captures SKIPS (a no-payment-method / zero-total skip writes no transaction row).
 * `ok:true` because these are recorded, expected per-sub outcomes (not run failures); the assertion
 * reads `produced.outcome`, not ok. `kind:'reactive'` keeps these high-volume beats out of the
 * cron/agent-kind `control_tower_loop_beats` RPC. Best-effort — never throws.
 */
export function emitRenewalOutcomeHeartbeat(outcome: RenewalOutcome): Promise<void> {
  return emitLoopHeartbeat(RENEWAL_OUTCOME_LOOP_ID, "reactive", { ok: true, produced: { outcome } });
}

/** Per-cycle renewal outcome counts (the breakdown the outcome-distribution assertion + the cron heartbeat carry). */
export interface RenewalOutcomeCounts {
  total: number;
  charged: number;
  skipped_no_payment_method: number;
  skipped_zero_total: number;
  declined_to_dunning: number;
  comp_shipped: number;
  comp_blocked: number;
  skipped_other: number;
}

function emptyRenewalOutcomeCounts(): RenewalOutcomeCounts {
  return {
    total: 0,
    charged: 0,
    skipped_no_payment_method: 0,
    skipped_zero_total: 0,
    declined_to_dunning: 0,
    comp_shipped: 0,
    comp_blocked: 0,
    skipped_other: 0,
  };
}

/**
 * READ-ONLY: aggregate the per-sub renewal outcome beats in a time window into a count breakdown.
 * Used by the renewal cron (bakes the just-completed cycle's breakdown into its heartbeat) AND by
 * the Control Tower outcome-distribution assertion (live current cycle + rolling baseline). Bounded
 * (`limit 5000`) + best-effort — a read failure returns zeros (never false-fires the assertion).
 */
export async function aggregateRenewalOutcomes(
  admin: ReturnType<typeof createAdminClient>,
  sinceIso: string,
  untilIso?: string,
): Promise<RenewalOutcomeCounts> {
  const counts = emptyRenewalOutcomeCounts();
  try {
    let q = admin
      .from("loop_heartbeats")
      .select("produced")
      .eq("loop_id", RENEWAL_OUTCOME_LOOP_ID)
      .gte("ran_at", sinceIso)
      .order("ran_at", { ascending: false })
      .limit(5000);
    if (untilIso) q = q.lt("ran_at", untilIso);
    const { data } = await q;
    for (const row of (data ?? []) as Array<{ produced: unknown }>) {
      const p = row.produced;
      const outcome = p && typeof p === "object" ? (p as Record<string, unknown>).outcome : null;
      if (typeof outcome === "string" && outcome in counts && outcome !== "total") {
        counts[outcome as keyof RenewalOutcomeCounts]++;
        counts.total++;
      }
    }
  } catch (e) {
    console.warn(`[control-tower] aggregateRenewalOutcomes read failed:`, e instanceof Error ? e.message : e);
  }
  return counts;
}
