# libraries/approval-router

The org-chart **approval router** — routes an approval **up** the org chart to the first live+autonomous supervisor, else the **CEO** ([[../specs/approval-routing-engine]] Phase 1, the keystone of [[../goals/devops-director]]).

**File:** `src/lib/agents/approval-router.ts`

## Why this exists

North star ([[../operational-rules]] § supervisable autonomy): an autonomous tool answers to an objective-owner, never a silent proxy. When a tool needs sign-off, the request must route to the first **ancestor function** that is trusted to decide — not scatter across the [[../dashboard/control-tower]] feeds, spec cards, and box deep-links. This module is that router: given a raising tool's owner function, it resolves *who decides*. The flags it reads live in [[../tables/function_autonomy]].

## Safety invariants (baked into `resolveApprover`)

- **Route UP, never sideways or down** — only ancestors (and the CEO) are ever considered. A live+autonomous *peer* never captures another function's approval.
- **Default to CEO** — any function not `live && autonomous` (the all-off default today) falls through to the CEO. A **missing flag row ⇒ off**, so an unconfigured org never auto-approves (**fail-safe**).
- **Acyclic-safe** — a `visited` guard defends a malformed chart (returns CEO, never loops).
- The **owner function itself is the first candidate** — a live+autonomous owner approves its own tools' requests.

## The graph

The org chart is the `functions/*.md` tree, which today is **FLAT**: every director reports to the CEO (there is no director-of-directors). `buildOrgChartGraph` reads the slug list from the brain ([[brain-roadmap]] `listFunctionSlugs`) and maps every slug → `CEO` — no hand-maintained second copy of the org chart. The walk is written generically (a `parentOf` map + visited guard) so a future **deeper** chart Just Works with no change to `resolveApprover`.

## Exports

- **`CEO`** = `"ceo"` — the implicit fallback root (never a [[../tables/function_autonomy]] row).
- **`resolveApprover(ownerFunction, chart, autonomy)`** → `string` — **PURE**. Walk up from `ownerFunction` (itself included) to the first `live && autonomous` ancestor; else `CEO`. Null/undefined/`ceo` owner ⇒ `CEO`. Unit-tested against fixture trees (`approval-router.test.ts`, `npm run test:approval-router`).
- **`isAutoApprover(slug, autonomy)`** → `boolean` — both flags must be on.
- **`buildOrgChartGraph()`** → `OrgChartGraph` — the live parent map from the brain.
- **`loadAutonomyMap()`** → `AutonomyMap` — the live flags from [[../tables/function_autonomy]] (error/empty ⇒ `{}`, all off).
- **`resolveApproverLive(ownerFunction)`** → `Promise<string>` — convenience: builds the chart + loads the flags, then calls the pure `resolveApprover`.

## Types

- **`AutonomyMap`** = `Record<slug, { live, autonomous }>` — a missing slug ⇒ off.
- **`OrgChartGraph`** = `{ parentOf: Record<slug, parentSlug> }` — a function reporting to the CEO maps to `CEO` (or is absent — both mean the parent is the CEO).
- **`FunctionAutonomyRow`** — one [[../tables/function_autonomy]] row.

## Callers

- [[../dashboard/agents|org-chart.ts]] `getOrgChart` — `loadAutonomyMap` + `isAutoApprover` derive each director's `offline ｜ live ｜ autonomous` status badge on the Agents hub.
- [[approval-inbox]] `reconcileApprovalInbox` / `buildApprovalNotification` (M2 Phase 2, **wired**) — calls `resolveApprover` on every `needs_approval` job to stamp `routed_to_function`, emitting the routed Approval Request into the resolved role's M1 inbox.
- `src/app/api/developer/agents/inbox/route.ts` — `loadAutonomyMap` + `isAutoApprover` decide a director's `routesToCeo` (only an auto-approver captures approvals).

## Related

[[../specs/approval-routing-engine]] · [[../tables/function_autonomy]] · [[../dashboard/agents]] · [[brain-roadmap]] · [[../goals/devops-director]] · [[../libraries/security-agent]] · [[../specs/security-dependency-agent]] · [[../operational-rules]]
