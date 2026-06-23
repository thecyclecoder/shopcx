# Approval routing engine — route up the org chart to first live boss, else CEO ⏳

**Owner:** [[../functions/platform]] · **Parent:** M2 — Approval routing engine
**Blocked-by:** [[agents-hub-role-inboxes]]

The **keystone** of the [[../goals/devops-director]] goal. Every agent/tool has an owner function (its director); when it needs sign-off, the approval must route **up the org chart to the first live + autonomous supervisor**, else fall through to the **CEO**. Today every approval is raised against a scattered surface — the [[../dashboard/control-tower]] repair / db-health / coverage-registration feeds, the spec-card `needs_approval` cards, and the box page's `approvalHref` deep-links (defaulting to the Control Tower per [[../operational-rules]]) — all sitting on [[../tables/agent_jobs]] `needs_approval` + `pending_actions` with **no concept of a supervising role**. This milestone adds that concept: a per-function **`live + autonomous` flag** (the progressive-offload switch), a router that walks the org chart, an **autonomous-approval history / audit log** (supervisable autonomy — the CEO can always see what the proxy decided and why), and a migration of every scattered surface to **emit into the M1 routed inbox**. It pays off immediately even before any director is automated: with no director live, everything routes to the **one CEO inbox** instead of N surfaces. Success metric served: **mean time-to-approve down, zero dropped/stuck approvals**, and the auditable history that makes "% of approvals you never touch" measurable.

## Phase 1 — the `live + autonomous` flag + org-chart walk ✅
- ✅ shipped
- A per-function flag store — `function_autonomy` (columns: `function_slug` PK, `live boolean`, `autonomous boolean`, `updated_by`, `updated_at`), seeded **all-off** (today's reality: no director live). **Global config** (one row per function slug — the org chart is ShopCX's own singular DevOps org, not per-tenant; no `workspace_id`). Owner-only toggle on the M1 Agents hub — two checkboxes (Live + Autonomous; Autonomous disabled until Live, and forced off when Live is cleared) backed by `POST /api/developer/agents/autonomy`. Migration `20260701120000_function_autonomy.sql` + apply-script. Brain page [[../tables/function_autonomy]].
- `src/lib/agents/approval-router.ts` `resolveApprover(ownerFunction, chart, autonomy)` — **pure**: walk the org chart **up** from the raising tool's owner function (the owner itself the first candidate); the first ancestor with `live && autonomous` is the approver; if none, the **CEO**. Acyclic-safe (visited guard); a missing flag row ⇒ off (fail-safe). The graph (`buildOrgChartGraph`) reads the `functions/*.md` slugs via [[../libraries/brain-roadmap]] `listFunctionSlugs()` and is **flat today** (every director → CEO), generic for a deeper future chart. `resolveApproverLive` / `loadAutonomyMap` read the live flags. Unit-tested (`npm run test:approval-router`, 12 cases). Brain page [[../libraries/approval-router]]. The Agents-hub director badge (`offline ｜ live ｜ autonomous`) is now derived from these flags.

## Phase 2 — route approvals into the M1 inbox + investigation-inline ⏳
- ⏳ planned
- On any `agent_jobs` row entering `needs_approval` (and the Control-Tower-feed proposals: repair / db-health / coverage-register), call `resolveApprover` and emit an **Approval Request** into that role's inbox tab ([[agents-hub-role-inboxes]] M1), carrying the agent's **investigation + proposed fix inline** (the existing `pending_actions[].preview`/`summary`/`cmd`) so the decision is one read — no click-through to a separate surface.
- Keep the existing approve/answer endpoints (`POST /api/roadmap/approve`, `/api/roadmap/answer`) as the execution path; this milestone changes **where the request surfaces**, not how an approved action runs (worker still flips `queued_resume`).

## Phase 3 — autonomous-approval history (the audit log) ⏳
- ⏳ planned
- `approval_decisions` (columns: `id`, `agent_job_id`/`pending_action_id`, `raised_by_function`, `routed_to_function`, `decided_by` ∈ `ceo｜director｜human`, `decision` ∈ `approved｜declined｜escalated`, `reasoning`, `autonomous boolean`, `created_at`) — one row per routed decision. Brain page [[../tables/approval_decisions]]. This is the **supervisable-autonomy ledger** ([[../operational-rules]] § North star): when a future live director auto-approves, the CEO sees the decision + reasoning in **history**, never in the queue.
- A **Decision history** view in the routed inbox + on the Agents hub: filterable by function, decision, autonomous-vs-human.

## Phase 4 — migrate the scattered approval surfaces ⏳
- ⏳ planned
- Re-point the existing surfaces to emit into the routed inbox: the [[../dashboard/control-tower]] Repair / DB-Health / Coverage-registration feeds, the spec-card `needs_approval` cards, and the box page `approvalHref` deep-links (kill the 404-prone `/dashboard/roadmap/{slug}` fallthroughs per [[../operational-rules]]). The Control Tower keeps its **monitoring** panels; its **approval** feeds become a view onto the routed inbox (single source). Update the affected brain pages in the same PR.

## Safety / invariants
- **Route up, never sideways or down.** An approval only ever routes to an *ancestor* function or the CEO — never to a peer or a child. The graph walk is acyclic (the `functions/*.md` org chart is a tree).
- **Default to CEO.** Any function not `live && autonomous` (the default, all-off today) falls through to the CEO — **fail safe**: an unconfigured or partially-configured org never silently auto-approves.
- **Every autonomous decision is logged.** No auto-approval without an `approval_decisions` row capturing the reasoning — the CEO can always audit what the proxy decided and why ([[../operational-rules]] § North star). The flag enables *who decides*, never *whether it's recorded*.
- **Execution path unchanged.** Routing changes where a request surfaces; the approved-action executor (worker → `queued_resume`) is untouched, so no approval can execute by a path that skips the gate.
- **One inbox, no orphans.** After migration, no approval surfaces anywhere except the routed inbox — a `needs_approval` row with no resolvable approver is a bug (routes to CEO, never dropped).

## Completion criteria
- A per-function `live + autonomous` flag exists (owner-toggleable, seeded all-off) with a brain page.
- `resolveApprover` routes every approval to the first live+autonomous ancestor function, else the CEO, and is unit-tested against the org-chart tree.
- Every `needs_approval` (jobs + Control-Tower-feed proposals) surfaces as an Approval Request in the resolved role's M1 inbox with the investigation + proposed fix inline.
- An `approval_decisions` audit log records every routed decision (reasoning + autonomous flag) and is viewable as decision history.
- The scattered surfaces (Control Tower approval feeds, spec cards, box `approvalHref`) are migrated to emit into the routed inbox; brain pages updated.

## Verification

### Phase 1 (shipped) — flag + router + toggle
- Apply `npx tsx scripts/apply-function-autonomy-migration.ts` → expect `function_autonomy` present and **5 seeded rows** (growth/cmo/retention/cs/platform), all `live=false, autonomous=false`.
- Run `npm run test:approval-router` → expect **12 passing** cases (all-off ⇒ CEO; owner live+autonomous ⇒ owner; live-only ⇒ CEO; deeper-tree ancestor walk; cyclic ⇒ CEO; null/CEO owner ⇒ CEO).
- On `/dashboard/agents` as the owner, select any director → expect an **Autonomy** row with **Live** + **Autonomous** checkboxes; Autonomous is **disabled** until Live is checked. Check Live → badge flips to **live**; check Autonomous → badge flips to **autonomous** and the row reads "Approvals route here + log to history". Uncheck Live → Autonomous clears and the badge returns to **routes to CEO**. (`POST /api/developer/agents/autonomy` returns the resolved `{live, autonomous}`.)
- As a non-owner, `POST /api/developer/agents/autonomy` → expect **403**.

### Full engine (M2–M4)
- With all function flags off, trigger any `needs_approval` (e.g. a repair proposal) → expect it to surface as an **Approval Request in the CEO inbox** on `/dashboard/agents`, with the proposal's investigation + cmd preview inline, and **no** standalone card on the old surfaces.
- Set Platform `live=true, autonomous=true`, raise a Platform-owned approval → expect `resolveApprover` to route it to **Platform**, an `approval_decisions` row to record `routed_to_function='platform'`, and the CEO inbox to NOT show it (it appears in CEO **Decision history** instead).
- Set Platform `live=true, autonomous=false` → expect a Platform-owned approval to **fall through to the CEO** (live but not autonomous ⇒ not an auto-approver).
- Approve a routed request → expect the underlying `agent_jobs` row to flip `queued_resume` and execute exactly as before (execution path unchanged).
- Grep the codebase / click through the old surfaces → expect Control-Tower approval feeds, spec cards, and the box `approvalHref` to deep-link into the routed inbox (no `/dashboard/roadmap/{slug}` 404 fallthrough).
