/**
 * Shared execution-time kill-switch guard (cron-and-tool-executor-kill-switch-enforcement, Phase 1).
 *
 * Every non-box execution site — the ~50 registered Inngest crons, the 4 inline AI agents, the 6
 * reactive event handlers, the media-buyer autonomous executor, the Meta ad-adapter tool bodies —
 * calls `enforceSwitch(nodeId)` as its first body step and returns on `{ ok: 'blocked_off' }`. The
 * box claim RPC already enforces the switch at the box lane; this guard closes the M3 chokepoint
 * over every path that lives OUTSIDE that RPC (Phases 2 + 3 wire the call sites).
 *
 * Two observable behaviours that make the switch supervisable:
 *
 *   1. **Cascade-aware** — the guard consumes [[./kill-switch-resolver]] `resolveEffectiveSwitch`,
 *      so a department-off row on `growth` blocks every growth-owned cron / reactive / agent /
 *      tool without a per-site kill_switches row. Cascade lives in ONE place; each caller is a
 *      one-liner: `if ((await enforceSwitch(id)).ok === 'blocked_off') return;`.
 *
 *   2. **Off is never silent** — on a block, the guard emits a `loop_heartbeats` row for the same
 *      node with `ok:true, produced:{ blocked_off:true, offBy, scope }` via the matching
 *      [[./heartbeat]] helper (`emitCronHeartbeat` for cron nodes, `emitInlineAgentHeartbeat` for
 *      inline agents, `emitReactiveHeartbeat` for reactive fns, `emitAgentHeartbeat` for box
 *      agent-kind / tool nodes). The CT tile then renders AMBER `off by <ancestor> (<scope>)`
 *      instead of RED "no beats" — the difference between an intentional off and an outage.
 *
 * **Fail-open on error.** If the resolver read fails, the emitter throws, or the caller passes an
 * un-registered nodeId, the guard returns `{ ok: 'run' }` — a transient blip must never silently
 * halt every execution path. This mirrors [[./kill-switch-resolver]]'s "missing row ⇒ ON" polarity.
 *
 * **Composable.** `enforceSwitchWith(nodeId, deps)` is the pure-DI form the test suite exercises
 * with a fixture map + a spy emitter, so cascade + beat-shape can be pinned without touching the
 * DB. `enforceSwitch(nodeId)` is the live one every call site uses.
 */
import {
  resolveEffectiveSwitch,
  type EffectiveSwitch,
  type KillSwitchScope,
} from "@/lib/control-tower/kill-switch-resolver";
import { emitLoopHeartbeat, type HeartbeatInput } from "@/lib/control-tower/heartbeat";
import { getNode } from "@/lib/control-tower/node-registry";
import type { LoopKind } from "@/lib/control-tower/registry";

/** The verdict returned by the guard. On `blocked_off`, the beat has already been emitted. */
export type EnforceSwitchResult =
  | { ok: "run" }
  | { ok: "blocked_off"; offBy: string; scope: KillSwitchScope };

/**
 * Injection surface for tests + integration seams. Real callers use the zero-dep `enforceSwitch`
 * form below, which wires these to the live [[./kill-switch-resolver]] + [[./heartbeat]] modules.
 */
export interface EnforceSwitchDeps {
  /** Resolve the effective switch for a node id (canonical or raw slug — both work). */
  resolve: (nodeId: string) => Promise<EffectiveSwitch>;
  /** Emit a `loop_heartbeats` row for the blocked node (best-effort — errors swallowed). */
  emit: (loopId: string, kind: LoopKind, input: HeartbeatInput) => Promise<void>;
}

/**
 * Map a canonical NodeKind (from [[./node-registry]]) to the LoopKind used when writing the
 * blocked-off heartbeat. Departments and directors aren't execution sites, but if a guard ever
 * fires on one we still want a beat — fall back to `'cron'` so the write succeeds against the
 * `loop_heartbeats.kind` CHECK constraint.
 */
function loopKindForNode(nodeId: string): LoopKind {
  const node = getNode(nodeId);
  if (!node) return "cron";
  switch (node.kind) {
    case "cron":
      return "cron";
    case "reactive":
      return "reactive";
    case "inline-agent":
      return "inline-agent";
    case "agent":
      return "agent-kind";
    case "tool":
      return "worker";
    case "department":
    case "director":
      return "cron";
  }
}

/**
 * Pure-DI form of the guard — the test suite passes a fixture-backed `resolve` + a spy `emit` so
 * cascade + beat-shape can be verified without touching the DB. Behavior is otherwise identical
 * to the live `enforceSwitch` form.
 */
export async function enforceSwitchWith(
  nodeId: string,
  deps: EnforceSwitchDeps,
): Promise<EnforceSwitchResult> {
  let effective: EffectiveSwitch;
  try {
    effective = await deps.resolve(nodeId);
  } catch {
    // Fail-open — a resolver blip must never silently halt every execution path.
    return { ok: "run" };
  }
  if (!effective.off) return { ok: "run" };
  const { offBy, scope } = effective;
  const loopKind = loopKindForNode(nodeId);
  try {
    await deps.emit(nodeId, loopKind, {
      ok: true,
      produced: { blocked_off: true, offBy, scope },
      detail: `blocked by ${offBy} (${scope})`,
    });
  } catch {
    // Best-effort — the emit helper already swallows its own errors; this is a belt-and-braces
    // catch so an unusual thrown injection can't turn a supervisor-off into an execution.
  }
  return { ok: "blocked_off", offBy, scope };
}

/**
 * The live guard every non-box execution site calls at the top of its body. Consumes the live
 * resolver + heartbeat emitter. Returns `{ ok:'blocked_off', offBy, scope }` when a cascade hit
 * is found (with the beat already written), otherwise `{ ok:'run' }`.
 */
export function enforceSwitch(nodeId: string): Promise<EnforceSwitchResult> {
  return enforceSwitchWith(nodeId, {
    resolve: resolveEffectiveSwitch,
    emit: emitLoopHeartbeat,
  });
}
