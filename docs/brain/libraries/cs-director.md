# libraries/cs-director

The **CS Director agent** — the third director scaffold ([[../specs/cs-director-persona-and-org-placement]] Phase 1, [[../goals/guaranteed-ticket-handling|guaranteed-ticket-handling]] M5 "The autonomous CS Director"). Investigates every Approval Request **routed to CS** (`function_slug='cs'`) and either **auto-approves within the leash** (with the reasoning logged) or **leaves it for the CEO**. It **supervises** the existing CS tools ([[../specs/box-ticket-improve|ticket-improve]] + [[../specs/box-escalation-triage|escalation-triage]]) — it does **not** rebuild them.

**File:** `src/lib/cs-director.ts` — the Phase-2 executor `applyBoxCsDirectorCall` that materializes June's verdicts into real actions (approve_remedy → `executeSonnetDecision` + `deliverTicketMessage`; author_spec → the [[specs-table]] SDK; escalate_founder → linkage-back for the runner-minted CEO card). See § [Phase-2 executor — `applyBoxCsDirectorCall`](#phase-2-executor--applyboxcsdirectorcall) below.

## Why this exists

North star ([[../operational-rules]] § supervisable autonomy): **CEO → Director → tool**. CS's tools already work — the ticket-improve Max session, the analyzer/grader, the box-hosted solver→skeptic quorum sweep — but nothing supervises them **as a director**. The CX manager (`cs_manager`) has always been the ground-truth operator; this scaffold seats the **CS Director agent** (persona: 💬 **June** — the CS role in [[agent-personas]]) above the escalation-triage quorum in the escalation ladder so a routed CS approval no longer lands in the CEO inbox unattended, and every call is recorded to the supervisable-autonomy ledger ([[../tables/director_activity]], [[../tables/approval_decisions]]) so the CEO can audit **what** was decided and **why** — in history, never in the queue.

> **Operate + author, never build (CEO directive 2026-06-29).** The CS Director OPERATES its own software (its `function_autonomy` is *operational* autonomy) and AUTHORS specs for the tools it needs. It NEVER drives a build: **Ada / Platform / DevOps is the sole builder for every spec, all departments, permanently** ([[../functions/platform]]). A CS-owned spec's `owner` is attribution + where the finished tool's operation lives; the build is always Ada's. CS going live+autonomous does not move build-driving onto it. See [[../functions/cs]].

## Scope (what the CS Director owns)

- **The ticket-improve loop** ([[../specs/box-ticket-improve]]) — supervises the customer-action plans the Improve agent proposes, approves the in-leash ones, escalates the rest.
- **The escalation-triage quorum** ([[../specs/box-escalation-triage]]) — sits **above** the hourly solver→skeptic→quorum sweep in the escalation ladder: a no-quorum disagreement, an ambiguous verdict, or a proposal outside the CS leash routes to the CS Director instead of straight to the CEO.
- **Ticket-derived product specs** — a code recommendation from a ticket becomes a `owner=cs`, `Derived-from-ticket:` spec authored on the roadmap; the CS Director owns the authoring quality gate, then hands the build to [[../functions/platform|Ada]].
- **The conversation-rule library** ([[../tables/sonnet_prompts]] + grader-rule proposals) — reviews proposed rule changes surfaced by the analyzer/grader before they reach `admin`.

## How it decides (the leash, structural + soundness gates)

Two-gate pattern shared with [[platform-director]] + [[growth-director]]: a **structural** gate (which action class) *and* a **soundness** gate (a read-only investigation — *never rubber-stamps*). Concrete leash categories land in the M5 behavior spec; the identity+placement scaffold reserves the seat and the runtime guard.

- **Runtime guard.** Until [[../tables/function_autonomy]] `('cs','cs-director')` is `live + autonomous`, the CS Director is **dormant**: the router never enqueues a `cs-director` job and every downstream surface no-ops. Phase 2 of this spec seeds the `function_autonomy` row at the **safest available leash** ("dormant" / the enum's `off` label) so the seat exists but nothing acts autonomously until the CEO flips it live.
- **Always escalates** (never auto-approves): destructive/irreversible actions, a non-binary multi-CHOICE decision, a customer-refund action that exceeds the CS refund ceiling, a proposed `sonnet_prompts` / `grader_prompts` change with high blast radius, or anything the read-only investigation cannot confirm sound. Escalations route to the CEO via `escalateApprovalRequestToCeo` (the same plumbing Ada + Max use).

### Escalation-source-agnostic triage — every escalated ticket routes to June

June's triage covers **every** routine-owned escalated ticket, regardless of what escalated it. The eligibility gate is ticket-level only — `escalated_at` set, `escalated_to` null, `status` not archived/closed — and does NOT read `escalation_reason`. That means:

- **Orchestrator escalations** (`src/lib/action-executor.ts` `escalateTicket` — journey-not-found, holding-promise, self-heal failures, verify-failed action bundles) → June-review candidate.
- **Analyzer / severity-rail escalations** ([[ticket-analyzer]] `applySeverityActions` — severe issue class or unresolved customer situation) → June-review candidate.
- **Playbook guard-block escalations** (`action-executor.ts` `claimGuardBlocksInlineSend` — `blocked_unbacked_claim:*` for a cancel / pause / skip / swap effect the reply asserted without a matching action) → June-review candidate on the same terms.
- **Workflow-executor escalations** (`src/lib/workflow-executor.ts` no-quorum path) and **portal remediation** (`src/lib/portal/remediation.ts`) → June-review candidate.

The invariant is pinned in code by the pure predicate [`passesJuneReviewSelection`](../../../src/lib/inngest/triage-escalations.ts) (unit-tested in `src/lib/inngest/triage-escalations.selection.test.ts`) and defensively re-applied on the fetched row-set in `triage-escalations-cron` so a future SQL edit can't quietly leak an ineligible ticket or silently source-filter a real one. Derived-from-ticket 472310cc-f35f-4631-8e3a-11d7ee7b585f — a `blocked_unbacked_claim` escalation that sat open + escalated with zero `triage_runs` — is the failing state this contract exists to prevent ([[../specs/guard-block-escalations-reach-junes-triage-not-left-unreviewed]]).

### Phase 1 — the `cs-director-call` box lane (third rung of the escalation ladder)

[[../specs/cs-director-third-rung-hard-calls-above-triage-quorum]] Phase 1 wires the runtime seat for the escalation-ladder placement above. A `kind='cs-director-call'` `agent_jobs` row is claimed by the box worker's `cs-director-call` lane (`scripts/builder-worker.ts` `runCsDirectorCallJob`, concurrency-1, gated on the Claude-down breaker), which runs a top-level Max `claude -p` (the `cs-director-call` skill) against the ticket. The session's brief bakes in:

1. The **ticket** — subject / channel / status / escalation reason + full conversation (via `loadTriageBrief`).
2. The **customer, subscriptions, and last 5 orders** — the same commerce/* slice the triage lane uses.
3. The **[[../tables/ticket_resolution_events]] ledger** — every prior orchestrator turn's `problem` / `confidence` / `verified_outcome` / `reasoning`. A repeated `drifted` / `unbacked` outcome is the signal that a rule / analyzer / product gap is underneath (→ `author_spec`), not a customer-side patch (→ `approve_remedy`).
4. The **[[../tables/triage_runs]] row** that dispatched the call — solver decision + skeptic verdict + no-quorum reasoning (why the box quorum missed).
5. **Live `sonnet_prompts`** — the rules the orchestrator reads every turn (so June sees what the system already tried to enforce).

The session emits ONE JSON object — the **verdict**:

- **`decision: 'approve_remedy'`** — the right customer-facing fix is clear AND in leash (reversible OR trivially bounded — a coupon / a partial refund inside the CS refund ceiling / a sub pause / a resend). Payload: `remedy: RemedyPlan` (action_type / summary / payload / confidence). `applyBoxCsDirectorCall`'s `approve_remedy` handler fires it through `executeSonnetDecision` (the same real executor prod uses; see [[../recipes/run-orchestrator-action]]) and — ONLY after the executor returns without escalation — delivers the RemedyPlan's `customer_message` via `deliverTicketMessage`. See § [Phase-2 executor — `applyBoxCsDirectorCall`](#phase-2-executor--applyboxcsdirectorcall) below.
- **`decision: 'author_spec'`** — the ledger shows a recurring `drifted` / `unbacked` outcome the code / rules keep failing on; the right fix is code, not a customer-side patch. Payload: `spec_seed: SpecSeed` (`slug` / `title` / `intent` / `problem` / `target?`). `applyBoxCsDirectorCall`'s `author_spec` handler hands it to the [[specs-table]] SDK (`authorSpecRowStructured`) with `owner='cs'` and a `**Derived-from-ticket:** {ticket_id}` header on the summary; the BUILD is always Ada's ([[../functions/platform]] — the CEO directive 2026-06-29), so the authored spec lands with `autoBuild: false` and commissions from the Roadmap.
- **`decision: 'escalate_founder'`** — a real judgment the CEO must make: destructive / irreversible / out-of-leash / non-binary / storyline-shaped / the read-only investigation could not confirm sound. Payload: `reasoning` (always — the 2-4 sentence diagnosis) + `recommended_remedy` (OPTIONAL RemedyPlan-shaped `{kind, summary}` — omit only when the call is a policy/storyline judgment with no concrete action to propose). The runner ALWAYS mints a CEO `dashboard_notifications` row on this verdict — see § [Escalate to founder → CEO card contract](#escalate-to-founder--ceo-card-contract) below.

The runner records the verdict to [[../tables/director_activity]] as `{ director_function:'cs', action_kind:'cs_director_call', spec_slug: verdict.spec_seed.slug ?? null, reason: verdict.reasoning, metadata:{ job_id, ticket_id, triage_run_id, decision, remedy, spec_seed, recommended_remedy, autonomous:true, phase:2 } }` — the audit trail the CEO / recap / #directors board sees WHAT the CS Director decided and WHY. `autonomous:true` / `phase:2` reflect that the runner then IMMEDIATELY hands the SAME normalized verdict to the Phase-2 executor `applyBoxCsDirectorCall` (in [`src/lib/cs-director.ts`](../../../src/lib/cs-director.ts)) — no CEO wait, no manual re-drive.

An unparseable verdict from the session parks the job `needs_attention` (a human eyeballs `log_tail`) and does NOT write an audit row — a lie in the ledger is worse than a gap. A `decision` field missing / not one of the three literals falls back to `escalate_founder` in `normalizeCsDirectorVerdict` — the shape-safe conservative default (never silently upgrade to auto-approve / auto-author).

### Phase-2 executor — `applyBoxCsDirectorCall`

[[../specs/cs-director-call-phase-2-executor-fires-june-verdicts]] (all four phases shipped) — the deterministic mutator in [`src/lib/cs-director.ts`](../../../src/lib/cs-director.ts) that materializes a recorded verdict into a real action. Same shape as `applyBoxDeployReview` in [[deploy-guardian]] (Reva's Phase-3 mutator): the box session decides read-only + returns a typed verdict; this writer routes it to the per-decision handler. Called once per `kind='cs-director-call'` job by `runCsDirectorCallJob` (scripts/builder-worker.ts) IMMEDIATELY after the `director_activity` audit row above — the mutator sees the SAME normalized verdict the audit trail carries.

The derived-from state — ticket `115350d5` (portal changedate escalation), where June ruled `approve_remedy: change_next_date -> 2026-10-06` at 06:35 and NOTHING fired until a human ran it by hand — is the concrete failure this executor closes.

**Verdict → handler routing:**

| `verdict.decision`   | Handler in `cs-director.ts`   | What it writes                                                                                                                                                             |
|----------------------|-------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `approve_remedy`     | `handleApproveRemedy`         | Fires `verdict.remedy.action_type` via `executeSonnetDecision`, THEN delivers `verdict.remedy.customer_message` via `deliverTicketMessage` — only on a clean executor return |
| `author_spec`        | `handleAuthorSpec`            | `authorSpecRowStructured` (the [[specs-table]] SDK) with `owner:'cs'`, `autoBuild:false`, `**Derived-from-ticket:** {ticket_id}` in the summary                             |
| `escalate_founder`   | `handleEscalateFounder`       | Resolves `ticket_id` + `triage_run_id` from `job.instructions` and returns them as the LINKAGE-BACK payload — the runner is the SOLE writer of the CEO card (single-writer)  |
| anything else        | logged no-op (`ok:true`)      | `normalizeCsDirectorVerdict` already defends against shape drift; a decision that leaks past the guard never crashes the runner                                              |

**Execute-then-message rule** (the derived-from ticket's whole failure mode — never promise a fix you didn't ship). The `approve_remedy` handler enforces ordering explicitly:

1. Builds the `SonnetDecision` with `action_type:'direct_action'` and NO `response_message` — the executor has nothing to deliver via its own send path.
2. Passes a NO-OP `send` fn so any executor-internal message (verify-failure / escalate holding text) is SUPPRESSED.
3. Only AFTER `executeSonnetDecision` returns without escalation, calls `deliverTicketMessage` OURSELVES with the RemedyPlan's `customer_message`.

A failed action never sends a customer message — `handleApproveRemedy` returns `needs_attention:true` and the runner parks the job so a human eyeballs the `log_tail`. Failure paths: missing/malformed remedy · `ticket_id` unresolvable from `job.instructions` · ticket has no `customer_id` · executor threw · executor `escalated=true` on return · delivery threw after a successful action.

**Escalate-founder → CEO inbox** (single-writer principle). The runner mints the CEO `dashboard_notifications` card (see § [Escalate to founder → CEO card contract](#escalate-to-founder--ceo-card-contract) below) — `handleEscalateFounder` NEVER mints a second card (a duplicate would page the CEO twice). Its Phase-3 role is to RESOLVE the linkage-back payload (`linkage_ticket_id` + `linkage_triage_run_id` from `job.instructions`) and surface it on the result so the runner's `log_tail` names the linkage in a machine-readable form a bounce-back handler / audit join can pick up without re-parsing the CEO card's metadata JSON.

**Author-spec** goes through the specs SDK chokepoint (`authorSpecRowStructured`) — NEVER a raw `.from('specs').insert` per CLAUDE.md § "PM data WRITES go through the specs-table SDK" (enforced by `_check-pm-sdk-compliance.ts`). The summary carries `**Derived-from-ticket:** {ticket_id}` as the first line so a Roadmap reader can trace the spec to the ticket in one grep. `autoBuild:false` per the 2026-06-29 CEO directive — Ada builds every spec, all functions; a director-authored spec commissions on the Roadmap.

**Never throws.** The executor returns a structured `ApplyBoxCsDirectorCallResult` (`{ ok, handler, reason?, needs_attention?, error?, message_delivered?, spec_slug?, linkage_ticket_id?, linkage_triage_run_id? }`) — the runner logs it on `log_tail` and decides `needs_attention` vs `completed` from the flag. Same never-throws / structured-result contract `applyBoxDeployReview` uses.

### Loop closure — internal note + ticket state per verdict

Every verdict CLOSES THE TICKET LOOP so a ruled-on ticket is never left in the `open+escalated+no-owner` limbo (spec [[../specs/cs-director-call-closes-the-ticket-loop-note-and-resolution-per-verdict]] Phase 2 invariant). Two writes happen after the `director_activity` audit row above — both compare-and-set / best-effort so a failure never rolls back the completed job:

1. **Internal note.** `runCsDirectorCallJob` writes ONE internal `ticket_messages` row (`visibility='internal'`, `author_type='system'`) naming June as the reviewer, the decision, the 2–4-sentence reasoning, and the concrete per-verdict output — the authored spec slug for `author_spec`, the RemedyPlan summary for `approve_remedy`, the founder-escalation reason for `escalate_founder`. Body composition lives in [[cs-director-verdict-note]] (pure, unit-tested). Before this shipped, an `author_spec` verdict left the ticket note-less — the CS agent scanning the queue couldn't tell it had been reviewed.
2. **Ticket state transition.** The runner then applies the per-verdict `tickets` patch from [[cs-director-ticket-transition]] via `.eq("id", ticketId).eq("workspace_id", …).select("id")` (compare-and-set — an async race that already advanced the ticket is logged as a zero-row miss, never silently overwritten):
   - **`author_spec`** → `status='closed'` + `resolved_at`/`closed_at` stamped + `assigned_to` / `escalated_at` / `escalated_to` / `escalation_reason` all cleared. The customer side is complete; the structural fix is tracked on the authored spec.
   - **`approve_remedy` with a no-customer-reply signal** (`remedy.needs_customer_reply=false` / `remedy.customer_reply=false` / `remedy.close_ticket=true` / `remedy.resolves_ticket=true` / `remedy.status='closed'|'resolved'`) → same close+clear patch as `author_spec`.
   - **`approve_remedy` default** (customer reply pending) → escalation cleared only (`escalated_at` / `escalated_to` / `escalation_reason` → `null`); status left `open` so the Phase-2 `applyBoxCsDirectorCall` executor's remedy delivery lands on a non-escalated queue (the executor SHIPS the reply itself on the same turn — see § [Phase-2 executor — `applyBoxCsDirectorCall`](#phase-2-executor--applyboxcsdirectorcall)).
   - **`escalate_founder`** → escalation NOT cleared. `escalation_reason` is stamped with `'CEO — awaits founder ruling: <why>'` and (when a `workspace_members role='owner'` lookup resolves the founder's `user_id`) `escalated_to` is stamped with that user_id — so the ticket is OWNED by the founder rather than stranded on the routine's default lane.

Same `visibility='internal'` / `author_type='system'` note mechanism the rest of the pipeline uses ([[ticket-analyzer]], [[improve-plan-executor]], [[escalation]]) so the entry renders in the ticket thread as a non-customer note.

### Escalate to founder → CEO card contract

[[../specs/escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-recommendation]] pins the hard contract for the `escalate_founder` verdict — the derived-from ticket (June ruled `escalate_founder` on a real $26.89 grandfathered overcharge, no CEO notification was created, the escalation reached no one) proved the prior "black-swan or bust" routing swallowed the escalation:

1. **The card is always minted** (Phase 1). Every `escalate_founder` verdict — not just the ones the black-swan classifier flags (fraud / chargeback storm / systemic outage) — inserts one `dashboard_notifications` row of `type='agent_approval_request'` with `metadata.routed_to_function='ceo'`. That is the exact shape [[../functions/ceo]]'s approvals-feed reads (`buildApprovalsFeed` at `src/lib/agents/approvals-feed.ts`) into its **escalated** set — so the card lands in the same list every other CEO approval lands in, alongside its ticket deep-link (`/dashboard/tickets/<id>`). Build shape is a pure builder ([[cs-director-escalate-founder-card]], unit-tested). The prior batch-into-weekly-digest path is preserved as a SECONDARY storyline write for non-black-swan verdicts; the CEO card is the primary surface either way.
2. **The card carries a diagnosis + recommended remedy** (Phase 2). The body is two labeled lines: `Diagnosis: <June's 2-4 sentence reasoning>` + `Recommended remedy: <kind: summary>` (or `Recommended remedy: (none — CEO to decide the action)` when June did not name a concrete action). The founder can approve/adjust in one read — never a bare "needs human review". The structured recommendation persists on `metadata.recommended_remedy` verbatim so a downstream approver / bounce handler can pick it up without re-parsing the body. The `cs-director-call` skill prompt elicits `recommended_remedy` on every escalate_founder call where a concrete action is nameable (worked example in the prompt: `{"kind":"refund_and_price_lock","summary":"Refund $26.89 for the incorrect renewal + restore the $33.01 grandfathered price lock before next renewal"}`).
3. **Ticket state + note follow the loop-closure contract** (Phase 3, this spec). The internal note ([[cs-director-verdict-note]]) also carries the `Recommended remedy: …` line when present — the ticket thread and the CEO card carry the SAME diagnosis + recommendation, so a CS agent scanning the ticket sees what the founder sees. Ticket state stays escalated + CEO-owned per [[cs-director-ticket-transition]]'s `keep_escalated_ceo_owned` patch (escalation NOT cleared; `escalation_reason` stamped `'CEO — awaits founder ruling: <why>'`; `escalated_to` stamped with the workspace owner's `user_id` when resolvable) — the ticket is OWNED by the founder, not stranded on the routine's default lane.

**Persistence.** The verdict's `recommended_remedy` persists to `director_activity.metadata.recommended_remedy` (audit trail) + `triage_runs.solver_transcript.recommended_remedy` (audit slice for the on-demand second-opinion path) + `dashboard_notifications.metadata.recommended_remedy` (CEO card) — three copies so a replay / reconciliation / grader can see the exact recommendation June proposed, not a paraphrase.

**Invariant.** An `escalate_founder` verdict is NEVER silently absent from the CEO inbox. A card-insert Supabase error logs at `ERROR` (`escalation reached no one`) — the concrete regression this spec fixes.

## Where it's wired (org placement)

- **Function:** `cs` ([[../functions/cs]] § Roles + approval names the CS Director seat alongside `cs_manager` + `admin`).
- **Reports to:** the CEO ([[../functions/ceo]]).
- **Sits above:** the [[../specs/box-escalation-triage|box-escalation-triage]] quorum in the escalation ladder — a routed CS approval that leaves the quorum uncertain lands with the CS Director, who either handles it in-leash or re-routes to the CEO.
- **Persona:** 💬 **June** — the CS role in [[agent-personas]] (`PERSONAS['cs']` + the `PERSONAS['cs-director']` alias exposed by this scaffold so callers can look up either key). Reskinnable there.
- **Avatar:** `agent-avatars/cs-director.png` (public bucket + `public/agent-avatars/cs-director.png` in-repo fallback; degrades to the June mascot until the headshot is uploaded — same pattern as Reva).

## Gotchas

- **The persona already existed as `cs: June`** — a director role in [[agent-personas]] keyed by the function slug. This scaffold ADDS the `cs-director` key so the org chart + inbox surfaces can look up "the CS Director agent" by its explicit name (matching how [[platform-director]] + [[growth-director]] are referenced), without dropping the `cs`-keyed lookup every existing caller uses. Both keys resolve to the same June identity.
- **The `cs-director.ts` module has shipped.** Historical note (M5 scaffold): the file lists the identity + placement scaffold as "pending — the `cs-director.ts` module lands in the M5 behavior specs". That is now shipped as the Phase-2 executor `applyBoxCsDirectorCall` (see § [Phase-2 executor — `applyBoxCsDirectorCall`](#phase-2-executor--applyboxcsdirectorcall)). The remaining M5-scaffold references (`runCsDirectorJob` for non-`cs-director-call` approvals, `enqueueCsDirectorJobs`, the Phase-4 daily board watch) still land in later M5 behavior specs — the `cs-director-call` box lane is only one of several surfaces the CS Director will operate on.
- **The CS Director does NOT drive builds.** Per the CEO directive (2026-06-29), a CS-owned spec's build is always Ada's; the CS Director authors + operates but never builds.

## Related

[[../functions/cs]] · [[../functions/ceo]] · [[agent-personas]] · [[platform-director]] · [[growth-director]] · [[deploy-guardian]] · [[../specs/box-ticket-improve]] · [[../specs/box-escalation-triage]] · [[../tables/function_autonomy]] · [[../tables/director_activity]] · [[../tables/approval_decisions]] · [[../operational-rules]] · [[cs-director-escalate-founder-card]] · [[cs-director-verdict-note]] · [[cs-director-ticket-transition]] · [[../recipes/run-orchestrator-action]]
