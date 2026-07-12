# libraries/kill-switch-resolver

The **cascade resolver** behind the CEO Control Tower kill switch ([[../specs/kill-switches-table-and-cascade-resolver]] Phase 2) — reads [[../tables/kill_switches]] once per snapshot, walks the [[control-tower-node-registry|canonical node registry]] parent→parent from a query node up to the department seat, and returns the first ancestor that has an OFF row. **Cascades down, never up.** A department-off row switches every descendant off; a leaf-off row does not affect its parent or a sibling.

**Files:** `src/lib/control-tower/kill-switch-resolver.ts` · `src/lib/control-tower/kill-switch-resolver.test.ts`

## Contract

```ts
type EffectiveSwitch =
  | { off: true; offBy: string; scope: 'department' | 'director' | 'agent' | 'tool'; reason: string | null }
  | { off: false };

resolveEffectiveSwitch(nodeId: string): Promise<EffectiveSwitch>
resolveEffectiveSwitchMany(nodeIds: readonly string[]): Promise<Map<string, EffectiveSwitch>>
resolveEffectiveSwitchFromMap(nodeId: string, map: KillSwitchMap): EffectiveSwitch  // pure — unit-testable
loadKillSwitchMap(admin?: Admin): Promise<KillSwitchMap>
invalidateKillSwitchCache(): void
```

## Invariants (pinned by `kill-switch-resolver.test.ts`)

- **MISSING ROW ⇒ OFF:false** — fail-open. An unconfigured registry never silently switches a node off. Mirrors [[approval-router]] `loadAutonomyMap` on the opposite polarity.
- **CASCADES DOWN, NEVER UP.** The walk goes from the query node UP to the department; a leaf-off row does not affect its parent director or the department. A department-off row cascades to every descendant.
- **NEAREST OFF WINS.** When two ancestors both have rows (e.g. `director:growth` AND `growth` are both off), the resolver returns the CLOSER one — the tightest attribution for the audit ledger.
- **SIBLING ISOLATION.** A `director:growth` row does not affect `director:cs` — the walk is vertical, not horizontal.
- **NODE-ID NORMALIZATION.** Accepts either a canonical registry id (`dept:growth`, `director:cs`, `agent:media-buyer`, `media-buyer-cadence-cron`) OR a raw agent-kind slug (`media-buyer`, `build`) — same contract as [[control-tower-node-registry]] `resolveNodeOwner`. Approval-inbox / agent-grader / model-tier-proposals callers don't have to translate first.
- **DEPARTMENT-KEY CONVENIENCE.** The row for a department is keyed by the FUNCTION SLUG (`growth`, matching [[../tables/function_autonomy]]'s convention) rather than the canonical registry id (`dept:growth`). The walk checks BOTH candidate keys at a department node so either stored form works.
- **UNREGISTERED NODES ⇒ OFF:false.** A caller passing an id the registry doesn't know gets treated as ON (fail-open); the [[control-tower-node-registry]] drift check is the durable fix for that surface, not this resolver.

## TTL cache + invalidation

`resolveEffectiveSwitch` uses a module-level 30-second TTL cache so a burst of enqueue-guards or a Control Tower snapshot pass doesn't hammer the pooler. `resolveEffectiveSwitchMany` (the M5 orphan-audit batched read) loads the map ONCE and walks every input id against the same snapshot — consistent within-batch answers, no read-skew if a write lands mid-scan. `invalidateKillSwitchCache()` is exported so the Phase 3 POST route can bust the cache immediately after a toggle so the next read sees the fresh state.

## Readers / writers

- **Phase 3 `POST /api/developer/control-tower/switch`** — the only writer to [[../tables/kill_switches]]; calls `invalidateKillSwitchCache()` after upsert/delete and returns the resolved effective switch for the toggled node.
- **Phase 4 enqueue-guards (Control Tower monitor, approval-inbox, box worker)** — read `resolveEffectiveSwitch(nodeId)` before an enqueue / claim / execute; an OFF result short-circuits the enqueue and records the attribution.
- **M5 orphan-node audit** — `resolveEffectiveSwitchMany(batch)` for a batched scan; every id resolves against the same snapshot.

## Related

[[../tables/kill_switches]] · [[control-tower-node-registry]] — the canonical org tree the walk consumes · [[../specs/kill-switches-table-and-cascade-resolver]] · [[../tables/function_autonomy]] · [[approval-router]] — sibling primitive on the opposite polarity · [[control-tower-self-audit]] · [[../goals/ceo-org-control-tower]] · [[../operational-rules]] (§ North star — supervisable autonomy)
