# libraries/cs-director

The **CS Director agent** — the third director scaffold ([[../specs/cs-director-persona-and-org-placement]] Phase 1, [[../goals/guaranteed-ticket-handling|guaranteed-ticket-handling]] M5 "The autonomous CS Director"). Investigates every Approval Request **routed to CS** (`function_slug='cs'`) and either **auto-approves within the leash** (with the reasoning logged) or **leaves it for the CEO**. It **supervises** the existing CS tools ([[../specs/box-ticket-improve|ticket-improve]] + [[../specs/box-escalation-triage|escalation-triage]]) — it does **not** rebuild them.

**File:** *(pending — the `cs-director.ts` module lands in the M5 behavior specs; this scaffold is identity + placement only.)*

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

### Phase 1 — the `cs-director-call` box lane (third rung of the escalation ladder)

[[../specs/cs-director-third-rung-hard-calls-above-triage-quorum]] Phase 1 wires the runtime seat for the escalation-ladder placement above. A `kind='cs-director-call'` `agent_jobs` row is claimed by the box worker's `cs-director-call` lane (`scripts/builder-worker.ts` `runCsDirectorCallJob`, concurrency-1, gated on the Claude-down breaker), which runs a top-level Max `claude -p` (the `cs-director-call` skill) against the ticket. The session's brief bakes in:

1. The **ticket** — subject / channel / status / escalation reason + full conversation (via `loadTriageBrief`).
2. The **customer, subscriptions, and last 5 orders** — the same commerce/* slice the triage lane uses.
3. The **[[../tables/ticket_resolution_events]] ledger** — every prior orchestrator turn's `problem` / `confidence` / `verified_outcome` / `reasoning`. A repeated `drifted` / `unbacked` outcome is the signal that a rule / analyzer / product gap is underneath (→ `author_spec`), not a customer-side patch (→ `approve_remedy`).
4. The **[[../tables/triage_runs]] row** that dispatched the call — solver decision + skeptic verdict + no-quorum reasoning (why the box quorum missed).
5. **Live `sonnet_prompts`** — the rules the orchestrator reads every turn (so June sees what the system already tried to enforce).

The session emits ONE JSON object — the **verdict**:

- **`decision: 'approve_remedy'`** — the right customer-facing fix is clear AND in leash (reversible OR trivially bounded — a coupon / a partial refund inside the CS refund ceiling / a sub pause / a resend). Payload: `remedy: RemedyPlan` (action_type / summary / payload / confidence). Phase 2's `applyBoxCsDirectorCall` fires it through `executeSonnetDecision` (the same real executor prod uses; see [[../recipes/run-orchestrator-action]]) and stamps `verified_outcome='confirmed'` on the resulting `ticket_resolution_events` row.
- **`decision: 'author_spec'`** — the ledger shows a recurring `drifted` / `unbacked` outcome the code / rules keep failing on; the right fix is code, not a customer-side patch. Payload: `spec_seed: SpecSeed` (`slug` / `title` / `intent` / `problem` / `target?`). Phase 2 hands it to the [[specs-table]] SDK with `owner_function_slug='cs'` and a Derived-from-ticket ref ([[../functions/cs]] § Ticket-derived product fixes); the BUILD is always Ada's ([[../functions/platform]] — the CEO directive 2026-06-29).
- **`decision: 'escalate_founder'`** — a real judgment the CEO must make: destructive / irreversible / out-of-leash / non-binary / storyline-shaped / the read-only investigation could not confirm sound. Payload: only `reasoning`. Phase 2 creates a CEO `dashboard_notifications` row with the ticket link + June's reasoning.

The runner is **read-only against everything except one write**: it records the verdict to [[../tables/director_activity]] as `{ director_function:'cs', action_kind:'cs_director_call', spec_slug: verdict.spec_seed.slug ?? null, reason: verdict.reasoning, metadata:{ job_id, ticket_id, triage_run_id, decision, remedy, spec_seed, autonomous:false, phase:1 } }`. That row is the audit trail — the CEO / recap / #directors board sees WHAT the CS Director decided and WHY, BEFORE Phase 2's mutator wires up. `autonomous:false` at Phase 1 flips to `true` in Phase 2 when the executor fires an in-leash remedy without asking the CEO.

An unparseable verdict from the session parks the job `needs_attention` (a human eyeballs `log_tail`) and does NOT write an audit row — a lie in the ledger is worse than a gap. A `decision` field missing / not one of the three literals falls back to `escalate_founder` in `normalizeCsDirectorVerdict` — the shape-safe conservative default (never silently upgrade to auto-approve / auto-author).

## Where it's wired (org placement)

- **Function:** `cs` ([[../functions/cs]] § Roles + approval names the CS Director seat alongside `cs_manager` + `admin`).
- **Reports to:** the CEO ([[../functions/ceo]]).
- **Sits above:** the [[../specs/box-escalation-triage|box-escalation-triage]] quorum in the escalation ladder — a routed CS approval that leaves the quorum uncertain lands with the CS Director, who either handles it in-leash or re-routes to the CEO.
- **Persona:** 💬 **June** — the CS role in [[agent-personas]] (`PERSONAS['cs']` + the `PERSONAS['cs-director']` alias exposed by this scaffold so callers can look up either key). Reskinnable there.
- **Avatar:** `agent-avatars/cs-director.png` (public bucket + `public/agent-avatars/cs-director.png` in-repo fallback; degrades to the June mascot until the headshot is uploaded — same pattern as Reva).

## Gotchas

- **The persona already existed as `cs: June`** — a director role in [[agent-personas]] keyed by the function slug. This scaffold ADDS the `cs-director` key so the org chart + inbox surfaces can look up "the CS Director agent" by its explicit name (matching how [[platform-director]] + [[growth-director]] are referenced), without dropping the `cs`-keyed lookup every existing caller uses. Both keys resolve to the same June identity.
- **Identity+placement only.** The M5 behavior specs land the `cs-director.ts` module, the `runCsDirectorJob` box lane, the leash categories, `enqueueCsDirectorJobs`, and the Phase-4 daily board watch. Until then, only the seat + persona + dormant `function_autonomy` row exist — nothing runs.
- **The CS Director does NOT drive builds.** Per the CEO directive (2026-06-29), a CS-owned spec's build is always Ada's; the CS Director authors + operates but never builds.

## Related

[[../functions/cs]] · [[../functions/ceo]] · [[agent-personas]] · [[platform-director]] · [[growth-director]] · [[../specs/box-ticket-improve]] · [[../specs/box-escalation-triage]] · [[../tables/function_autonomy]] · [[../tables/director_activity]] · [[../tables/approval_decisions]] · [[../operational-rules]]
