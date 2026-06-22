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
import { agentLoopId, type LoopKind } from "@/lib/control-tower/registry";

export interface HeartbeatInput {
  /** false ⇒ the run threw or reported a failure. Default true. */
  ok?: boolean;
  /** what the run produced (counts/summary) — stored as jsonb. */
  produced?: unknown;
  detail?: string;
  durationMs?: number;
}

export async function emitLoopHeartbeat(
  loopId: string,
  kind: LoopKind,
  input: HeartbeatInput = {},
): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from("loop_heartbeats").insert({
      loop_id: loopId,
      kind,
      ok: input.ok ?? true,
      produced: input.produced ?? null,
      detail: input.detail ?? null,
      duration_ms: input.durationMs ?? null,
      ran_at: new Date().toISOString(),
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
