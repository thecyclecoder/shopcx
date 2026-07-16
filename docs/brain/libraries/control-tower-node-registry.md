# libraries/control-tower-node-registry

The **canonical org tree** ([[../specs/control-tower-canonical-node-registry]]) — one fused registry every worker, tool, agent-kind, cron, reactive fn, and inline agent resolves to exactly one `OwnerFunction` through. Replaces the three sources that used to disagree (`MONITORED_LOOPS`, `personas.KIND_PERSONA_ALIAS`, the `scripts/builder-worker.ts` job-kind union) with a single graph — so the M4 CEO glance (department → director → agent → tool) reads a coherent org chart, orphan-audit walks nodes, and the north-star rule "a supervisor owns the layer below it" enforces the trio per node.

**Files:** `src/lib/control-tower/node-registry.ts` · `src/lib/control-tower/node-registry.test.ts` · `scripts/_check-node-registry-drift.ts`

## Why this exists

Before Phase 1, three overlapping sources tried to answer "who owns this box lane?":

1. [[control-tower]] `MONITORED_LOOPS` — declared `owner: OwnerFunction` per cron / reactive / agent-kind / inline-agent row.
2. [[../libraries/agent-personas|personas.ts]] `KIND_PERSONA_ALIAS` — mapped an `agent_jobs.kind` slug to a persona key, indirectly implying an owner via the persona's function.
3. `scripts/builder-worker.ts` `dispatchJob` — the authoritative kind universe the box actually drains, some of which had no MONITORED_LOOPS row (director sweeps like `agent-grade` / `director-grade`, proposal-only kinds like `db_health` / `coverage-register`).

Each source had gaps the others filled by accident. The [[approval-inbox]] `KIND_TO_FUNCTION` shim hand-patched the resulting misalignments row-by-row. This module is that shim's supersession: ONE registry, every node placed exactly once.

## Node model

```ts
type NodeKind = "department" | "director" | "agent" | "tool" | "cron" | "reactive" | "inline-agent";

interface OrgNode {
  id: string;               // reuses the MONITORED_LOOPS id, or `dept:<fn>` / `director:<fn>` / `agent-kind:<kind>`
  kind: NodeKind;
  parent: string | null;    // nodeId of the seat above; null for a root department
  owner: OwnerFunction;     // the org-chart function that owns this node
  persona?: MascotId;       // MascotId from [[../libraries/agent-personas]] — narrow union
  label: string;
}
```

## The tree

```
CEO (fail-safe root — approvals fall through here when no live+autonomous director qualifies)
├── dept:platform        Ada — build system, agent platform, dev tooling, spec process
│   └── director:platform
│       ├── box (WORKER_BOX_ID)                  — the box build worker (tool)
│       ├── every cron/reactive owner="platform" — control-tower-monitor, spec-drift, db-health-*, deploy-guardian-cron, mario-*, brain-index-refresh, [[../inngest/approval-enqueue-director]] (sub-min approval reactor), …
│       ├── agent:build (Bo), agent:plan (Pia), agent:fold (Fenn), agent:spec-test (Vera),
│       │   agent:repair (Rafa), agent:regression (Remi),
│       │   agent:security-review (Vault), agent:coverage-register (Cole), agent:pr-resolve (Pax),
│       │   agent:dev-ask (Dex), agent:spec-chat (Sage), plus the reactive box lanes
│       │   deploy-review-agent (Reva) and mario-agent (Mario)
│       ├── agent-kind:agent-grade, agent-coach, platform-director, director-coach,
│       │   director-bounce-back, proposed-model-tier, audit-spec-shipped-state, goal-fold, db_health
│       └── ai:fraud-detector (inline)
├── dept:growth          Max — paid acquisition, landing-page CRO
│   └── director:growth
│       ├── agent:storefront-optimizer (Cleo), agent:dr-content (Carrie)
│       ├── agent-kind:media-buyer (Bianca), ad-creative (Dahlia), media-buyer-grade,
│       │   research (Rhea), campaign-grade, gap-grade, growth-director,
│       │   sensor-trust-probe, calibrate-media-buyer-policy
│       └── Growth-owned crons (today-sync, meta-*, creative-finder-daily-cron,
│           landing-page-scout-daily-cron, storefront-*, growth-ad-spend-governor-cron, …)
├── dept:retention       Theo — subscriptions, dunning, cancel-flow, journeys
│   └── director:retention
│       ├── agent:migration-fix (Mira)
│       ├── Retention crons (internal-subscription-renewal-cron, dunning-payday-retry-cron,
│       │   portal-auto-resume-cron, chargeback-evidence-reminder, delivery-nightly-audit,
│       │   reviews/tag-cancel-relevance-cron, portal-action-healer)
│       └── Retention reactive fns (dunning-payment-failed, returns-process-delivery,
│           journey-session-completed, chargeback-received) + ai:journey-delivery (inline)
├── dept:cs              June — support quality, ticket-derived specs
│   └── director:cs
│       ├── agent:ticket-handle (Sol), agent:ticket-improve, agent:ticket-analyze (Cora),
│       │   agent:prompt-review (Prue), agent:triage-escalations
│       ├── agent-kind:cs-director-call, playbook-compile
│       ├── unified-ticket-handler (reactive) + agent-todo-execute + deliver-pending-sends
│       │   + ticket-analysis-cron + ticket-csat-cron + tickets-auto-archive
│       │   + sonnet-prompt-auto-review + cs-director-digest-composer + triage-escalations-cron
│       └── ai:ticket-analyzer + ai:orchestrator (inline)
├── dept:cmo             Iris — owned + organic (email, SMS, social, blog)
│   └── director:cmo
│       ├── agent:product-seed (Piper)
│       └── CMO crons (abandoned-cart-reminder, marketing-*, sms-marketing-cron (Margo),
│           auto-blog-generate, klaviyo-*, social-insights-sync, sync-klaviyo-reviews,
│           featured-review-cards, crisis-daily-campaign)
├── dept:cfo             Grace  (extension seat — no live workers yet)
├── dept:logistics       Marco  (extension seat — no live workers yet)
└── dept:ceo             Henry (founder-owned lane — not a rollup Health tile)
    └── director:ceo
        ├── god-mode-cockpit (reactive)   — Eve, the CEO's executive assistant
        └── agent-kind:god-mode, director-grade, proposed-goal, ceo-authorized-out-of-leash
```

## Exports (`node-registry.ts`)

- `NODES: readonly OrgNode[]` — the frozen tree above. Constructed once at module load and re-uses the MONITORED_LOOPS declared `owner` + `personaKind` verbatim, so drift stays impossible.
- `NodeKind`, `OrgNode` — the type surface a consumer walks.
- `resolveNodeOwner(nodeId: string): OwnerFunction | null` — the primary lookup. Accepts EITHER a canonical id (`agent:build`, `deploy-review-agent`, `god-mode-cockpit`) OR a raw agent-kind slug (`build`, `deploy-review`, `god-mode`); returns `null` on a genuine miss (never silently defaults to `platform`). Used by [[approval-inbox]] `ownerFunctionForKind`, [[agent-grader]] `gradeableKindsForFunction` + `detectGradeDropCoaching` + `applyBoxCoaching`, [[approvals-feed]] `raisedBy`, `model-tier-proposals` routing, [[platform-director]] `routesToPlatform`, [[../libraries/growth-director|growth-director]] `routesToGrowth`.
- `resolveNodeOwnerOrOrphanDefault(nodeId, context): OwnerFunction` — the Phase-2 replacement for the historical `ORPHAN_OWNER='platform'` fallthrough in [[../libraries/org-chart|org-chart]]. Walks the registry FIRST; on a genuine miss, `console.warn`s + bumps `getOrphanSightings()` before falling back to the historical `platform` default so caller behavior is preserved.
- `getOrphanSightings(): Record<string, number>` — snapshot of the sightings counter. Consumed by the `orphan-node-self-audit` Phase 1 sweep (a future spec).
- `resetOrphanSightings(): void` — used by the audit after a batch + by tests.
- `assertCoverage(): void` — throws on the first MONITORED_LOOPS id or BUILDER_WORKER_KINDS entry that doesn't resolve. Called by the Phase-3 drift check + the test suite.
- `getNode(nodeId): OrgNode | null` · `getParent(nodeId): OrgNode | null` · `getChildren(nodeId): OrgNode[]` — tree-walk convenience for the M4 CEO glance.
- `BUILDER_WORKER_KINDS: readonly BuilderWorkerKind[]` — the `agent_jobs.kind` universe emitted by `scripts/builder-worker.ts` `dispatchJob`. The Phase-3 drift check gates against the live worker's dispatch.
- `RETIRED_KIND_OWNER: Record<string, OwnerFunction>` — kinds the box **no longer dispatches** (removed from `BUILDER_WORKER_KINDS` + `dispatchJob`) but that still appear in `select distinct kind from public.agent_jobs` via **historical** rows. Each builds a `agent-kind:<slug>` node (labelled `… (retired)`) so `resolveNodeOwner(kind)` resolves — the live-kind coverage check requires every historical kind to map to an owner. Deliberately NOT in `BUILDER_WORKER_KINDS`, so the dispatch↔kinds drift check never expects a live lane. First entry: `spec-review` → `platform` (Vale, after `retire-vale-spec-review-becomes-deterministic-authoring-gate`).

## How to add a node

The registry is DERIVED, not authored: a node appears here because it exists in one of the source-of-truth files below. Add the node in the RIGHT source; the registry (and everything downstream — approval routing, grader owner-scoping, org-chart roster) picks it up automatically.

1. **A new box lane (`agent_jobs.kind` the worker dispatches)** — add a `MonitoredLoop` row in [[control-tower]] `registry.ts` (`kind:'agent-kind'`, an `agentKind:<slug>`, and a declared `owner: OwnerFunction`). If it's a reactive lane fired by an Inngest event (e.g. Reva's `deploy-review-agent`, Mario's `mario-agent`), use `kind:'reactive'` with the same `agentKind`. The registry picks up the row + carries its declared `owner`.
2. **A cron the box or Inngest owns** — add a `MonitoredLoop` row with `kind:'cron'`, its Inngest fn id, and an `owner`. If it maps to an existing worker persona (e.g. Tao / Devi / Rhea), set `personaKind:'monitor'|'db_health'|'research'` and the tree renders it under that worker. If it's a first-class new agent, add its persona in [[../libraries/agent-personas|personas.ts]] first.
3. **A director-sweep or proposal kind that ISN'T in MONITORED_LOOPS** (e.g. `agent-grade`, `director-grade`, `db_health`, `coverage-register`) — add a `KIND_OWNER_FALLBACK` entry in `node-registry.ts`, keyed by the slug, mapping to its owner. Then add the slug to `BUILDER_WORKER_KINDS` (or ensure the drift check will fail otherwise).
4. **The persona for the node** — add or upsert the entry in [[../libraries/agent-personas|personas.ts]] `PERSONAS` (keyed by the agent-kind slug). If the agent-kind slug ≠ the persona key (e.g. `deploy-review` → `deploy-guardian`), add the mapping to `KIND_PERSONA_ALIAS` too.
5. **Verify** — run `npx tsx --test src/lib/control-tower/node-registry.test.ts` (every id resolves, no orphans) and `npx tsx scripts/_check-node-registry-drift.ts` (the Phase-3 drift check runs source-of-truth ↔ registry symmetry).

**Retiring a kind** — when a box lane is retired (removed from `BUILDER_WORKER_KINDS` + `dispatchJob`), historical `agent_jobs` rows keep the kind in `select distinct kind`, so the live-kind coverage check still demands it resolve. Add the slug to `RETIRED_KIND_OWNER` (mapping to the owner it had) the same PR you remove the lane — this keeps a resolvable `agent-kind:<slug>` node without re-introducing a phantom dispatch expectation.

Every step is enforced by the drift check + the test suite; a missed piece surfaces as an actionable error, never a silent Platform default.

## `scripts/_check-node-registry-drift.ts` — the drift check

Static-analysis check (like `check:worker-lanes`, `check:table-refs-have-migrations`). Fails when:

- [[control-tower]] `MONITORED_LOOPS` has an `id` that `resolveNodeOwner(id)` doesn't resolve.
- [[../libraries/agent-personas|personas.ts]] `KIND_PERSONA_ALIAS` names a kind (either key or value) that the registry doesn't carry.
- `scripts/builder-worker.ts` `dispatchJob`'s `if (job.kind === "…")` union names a kind absent from `BUILDER_WORKER_KINDS` (or vice-versa).
- `resolveNodeOwner(k)` returns null for any `k` in `BUILDER_WORKER_KINDS`.

Wired into the `predeploy` chain in `package.json` (`npm run check:node-registry-drift`) so a regression fails CI red, not silently. Read-only by construction — prints the diff and exits non-zero on a mismatch; never mutates state.

## Cross-references

- [[control-tower]] `MONITORED_LOOPS` — source #1 of the fusion; declared `owner` is authoritative here.
- [[control-tower-self-audit]] — the CODE↔REGISTRY diff for Inngest crons (the coverage-register agent's finder). Complements the node-registry drift check on the OTHER dimension: self-audit catches an unregistered cron; node-registry catches an unregistered owner mapping.
- [[../tables/function_autonomy]] — the per-function live+autonomous toggle the [[approval-router]] walk consumes. `resolveApprover(resolveNodeOwner(kind), chart, autonomy)` is the north-star cascade: the registry picks the OWNER, the autonomy map decides whether that owner AUTO-DECIDES or falls through.
- [[../tables/kill_switches]] — the universal on/off primitive the CEO Control Tower switch writes to. Phase 2 [[kill-switch-resolver]] `resolveEffectiveSwitch(nodeId)` walks THIS registry parent→parent to cascade an ancestor-off row down to every descendant — turning `growth` off in one write stops every growth-owned director / agent / tool within one monitor tick. Missing row ⇒ ON (fail-open); the registry declares WHICH nodes exist, `kill_switches` declares which ones are OFF.
- [[approval-inbox]] `ownerFunctionForKind` — consumes `resolveNodeOwner` FIRST, then the compact `KIND_TO_FUNCTION_SHIM` (2 approval-only entries: `sms-marketing` / `growth-voice-angle-approval` — retired one spec at a time).
- [[agent-grader]] `gradeableKindsForFunction` — routes through `resolveNodeOwner` so a director's grade-sweep scope and the approval router agree on every kind by construction.
- [[../libraries/org-chart|org-chart]] `ORPHAN_OWNER` — kept as documentation of the audit hook; the runtime path now walks `resolveNodeOwnerOrOrphanDefault`.
