# libraries/enforce-switch

The **shared execution-time kill-switch guard** every non-box execution site calls at the top of its body ([[../specs/cron-and-tool-executor-kill-switch-enforcement]] Phase 1). Consumes [[kill-switch-resolver]] `resolveEffectiveSwitch`; on a cascade hit, writes an amber "off by <ancestor>" `loop_heartbeats` beat via the matching [[../inngest/control-tower]] emitter and returns `{ ok: 'blocked_off', offBy, scope }` so the caller can bail. The box claim RPC already enforces the switch at the box lane; this guard closes the M3 chokepoint over every path that lives OUTSIDE that RPC — the ~50 registered Inngest crons, the 4 inline AI agents, the 6 reactive event handlers, the media-buyer autonomous executor, and the Meta ad-adapter tool bodies (wired by Phases 2 + 3).

**Files:** `src/lib/control-tower/enforce-switch.ts` · `src/lib/control-tower/enforce-switch.test.ts`

## Contract

```ts
type EnforceSwitchResult =
  | { ok: 'run' }
  | { ok: 'blocked_off'; offBy: string; scope: 'department' | 'director' | 'agent' | 'tool' };

enforceSwitch(nodeId: string): Promise<EnforceSwitchResult>

// Pure-DI form the test suite exercises with a fixture map + spy emitter (no DB).
enforceSwitchWith(nodeId: string, deps: {
  resolve: (id: string) => Promise<EffectiveSwitch>;
  emit: (loopId: string, kind: LoopKind, input: HeartbeatInput) => Promise<void>;
}): Promise<EnforceSwitchResult>
```

Usage — every non-box execution site is a one-liner at the top of its body:

```ts
const gate = await enforceSwitch(FN_ID);
if (gate.ok === 'blocked_off') return; // beat already written; caller exits silently
// ...normal body...
```

## Invariants (pinned by `enforce-switch.test.ts`)

- **CASCADE-AWARE via [[kill-switch-resolver]].** A department-off row (`growth`, `cs`, `retention`, `platform`, `cmo`) blocks every descendant call site — one row, one guard, one attribution. Cascade lives in `resolveEffectiveSwitch`; this guard is a thin wrapper.
- **OFF IS NEVER SILENT.** On a block, the guard writes a `loop_heartbeats` row for the same nodeId with `ok:true, produced:{ blocked_off:true, offBy, scope }, detail:'blocked by <offBy> (<scope>)'`. The [[control-tower]] tile then renders AMBER "off by <ancestor>" instead of RED "no beats" — the difference between an intentional off and an outage.
- **EMITTER PICKED BY NODE KIND.** The guard reads the node's registered `NodeKind` from [[control-tower-node-registry]] and writes the beat with the matching `LoopKind`: `cron → cron`, `reactive → reactive`, `inline-agent → inline-agent`, `agent → agent-kind`, `tool → worker`. A guard fired on a seat (`department` / `director`) writes a `cron`-kind beat as a safe fallback (seats aren't execution sites, but the write shouldn't fail on the CHECK constraint if a caller does hit it).
- **FAIL-OPEN on error.** A resolver throw, an emit throw, or an unregistered nodeId all return `{ ok: 'run' }` — a transient blip must never silently halt every execution path. Mirrors [[kill-switch-resolver]]'s "missing row ⇒ ON" polarity.
- **NO BEAT when NOT blocked.** A clean map runs and does not emit — the guard is invisible on the happy path.
- **ATTRIBUTION PASSTHROUGH.** The `offBy` field in the returned verdict AND in the emitted beat mirrors the stored key form verbatim (bare slug `growth` OR canonical `dept:growth`) so the Control Tower ledger can reconstruct which key form the CEO wrote.

## Readers / writers

- **Phase 2 call sites (queued):** the 4 inline agents (`ai:ticket-analyzer`, `ai:journey-delivery`, `ai:fraud-detector`, `ai:orchestrator`) + the 6 reactive Inngest fns (`unified-ticket-handler`, `dunning-payment-failed`, `returns-process-delivery`, `journey-session-completed`, `agent-todo-execute`, `chargeback-received`) call `enforceSwitch(nodeId)` as their first body step after event-shape validation.
- **Phase 3 call sites (queued):** every [[control-tower#monitored_loops]] cron's decide-body + the media-buyer autonomous executor ([[director-activity]]) + the Meta adapter bodies ([[../integrations/meta]] execution + recommendation-execute) call `enforceSwitch(nodeId)` as their first `step.run()`. A CI lint (`scripts/_check-cron-enforce-switch.ts`) fails the build when a MONITORED_LOOPS cron's source omits the call.

## Related

[[kill-switch-resolver]] — the cascade resolver this guard wraps · [[control-tower]] — heartbeat emitters (`emitCronHeartbeat` / `emitInlineAgentHeartbeat` / `emitReactiveHeartbeat` / `emitAgentHeartbeat`) · [[control-tower-node-registry]] — canonical org tree the resolver walks · [[../tables/kill_switches]] · [[../tables/loop_heartbeats]] · [[../specs/cron-and-tool-executor-kill-switch-enforcement]] · [[../specs/claim-rpc-kill-switch-enforcement]] — the sibling guard on the box claim RPC · [[../goals/ceo-org-control-tower]] · [[../operational-rules]] (§ North star — supervisable autonomy)
