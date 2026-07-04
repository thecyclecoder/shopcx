# `scripts/builder-worker.ts` — the box worker

The deterministic Node process that runs every box-hosted agent lane. Polls [[../tables/agent_jobs]] on the build box, claims jobs of the kinds it knows, dispatches to a per-kind `run*Job` function, and (for kinds that need reasoning) spawns a `claude -p` Max session under a specific skill. The **worker is the only component with prod-write credentials** — every Max session it spawns runs read-only against DB + repo, proposes JSON, and the worker applies the proposal via a narrow SDK chokepoint. This is the mechanism the north-star "supervisable autonomy" rule ([[../operational-rules]] § North star) enforces: the tool proposes; the worker applies.

**Not a call graph — a manifest.** Each lane's real logic lives in its owning library / recipe page (linked below); this page is the box-worker map so a new lane knows the shape.

## Shape of a lane

Every kind's lane looks the same:

1. A **claim** poll — `db.rpc("claim_agent_job", { p_kinds: ["<kind>"] })` under a concurrency cap `MAX_<KIND>`.
2. A **dispatch** entry — `if (job.kind === "<kind>") return run<Kind>Job(job)`.
3. A **runner** — `run<Kind>Job(job)`: reads input off `job.instructions`, does deterministic prep (DB queries, subprocess launches), spawns a Max session via `runBoxLane(...)` + `runBoxSession(prompt, ..., { kind, sandbox: "max", timeout })`, parses the session's final JSON via `extractJson`, and applies through the owning SDK.
4. A **skill** at `.claude/skills/<kind>/SKILL.md` — the persona + output contract the Max session runs under.

CI static check `scripts/_check-worker-lanes.ts` enforces that every kind in the `Job.kind` union has (1) a claim lane, (2) a dispatcher entry (or a `DISPATCH_BY_FALLTHROUGH` exemption), and no dangling literals. Ownership routing lives in [[approval-inbox]] `ownerFunctionForKind`.

## Lanes (per-kind lookup)

| Lane / kind | Owner | Docs |
|---|---|---|
| `build` / `plan` (default fall-through) | [[../functions/platform]] | build lifecycle: [[../lifecycles/spec-goal-branch]] |
| `fold` / `goal-fold` | [[../functions/platform]] | [[../recipes/fold-to-brain]] |
| `spec-review` | [[../functions/platform]] | [[agents-spec-review]] |
| `spec-test` | [[../functions/platform]] | [[spec-test-agent]] |
| `agent-grade` / `agent-coach` | (per grader owner) | [[agent-grader]] · [[agent-coaching]] |
| `director-grade` | [[../functions/platform]] | [[director-grader]] |
| `campaign-grade` | [[../functions/growth]] | [[storefront-campaign-grader]] |
| `gap-grade` | [[../functions/growth]] | [[acquisition-gap-grader]] |
| `research` | [[../functions/growth]] | Rhea's URL sensor — see below |
| `security-review` | [[../functions/platform]] | [[security-agent]] |
| `ticket-improve` | (CS) | [[ticket-improve-chats]] |
| `triage-escalations` | (CS) | [[../lifecycles/agent-todo-system]] |
| `storefront-optimizer` | [[../functions/growth]] | [[storefront-optimizer-agent]] |
| `platform-director` / `director-bounce-back` / `growth-director` | (directors) | [[platform-director]] · [[growth-director]] |
| … | | See `Job.kind` union in `scripts/builder-worker.ts` for the complete set. |

## The `research` lane (Rhea's URL sensor, [[../specs/rhea-url-sensor]] Phase 2 + [[../specs/rhea-teardown-recipe]] Phase 2)

The Growth-owned lane that classifies unreviewed [[../tables/research_urls]] rows into `advertorial | quiz | generic_pdp | homepage | spam` + `worthy | not_worthy` verdicts with a rationale — and, in the SAME session, reverse-engineers every worthy URL into a structured [[../recipes/lander-teardown]] recipe (`TeardownRecipe`) persisted via `setTeardown`. Cleo (slice 3) reads those recipes to diff against our storefront and emit a build blueprint.

- **Enqueue** — [[../inngest/research-sensor]]'s HOURLY paced claim (rhea-research-automation Phase 1): syncs [[../tables/research_urls]] then picks the top `ad_count` unreviewed URL (`classification IS NULL AND teardown_verdict='unreviewed'`, tiebroken by earliest `first_seen`), dedups on any in-flight `research` job for the workspace, and inserts ONE `kind='research'` `agent_jobs` row carrying `{research_url_id}` in `instructions`. Supersedes the prior daily stub in [[../inngest/acquisition-research-cadence]].
- **Cap** — `MAX_RESEARCH=1` concurrency lane, `RESEARCH_TIMEOUT_MS=30 min`, `RESEARCH_BATCH_CAP=8` URLs per pass. Bumping the batch size is a knob (env-tunable), not a code change.
- **`runResearchJob(job)`** (the runner, in `scripts/builder-worker.ts`):
  1. Read the top-N unreviewed `research_urls` for the workspace, biggest `ad_count` first.
  2. Deterministic capture — dynamically import [[../../scripts/research-capture.ts]] and `captureBatch(...)`: mobile Playwright renders + geometric overlay-kill + DOM-first `<section>` chaptering with a vision-tile fallback ([[../recipes/lander-capture]]). Shots go to the private `research-shots` Storage bucket. Runs EXACTLY ONCE per URL (one-session invariant — no second render).
  3. Any URL whose capture returned `unviewable` after retries is marked `classification='unviewable'` deterministically via [[research-urls]] `setUrlClassification` (Rhea never guesses worthiness of a page she couldn't see — `unviewable ≠ not_worthy`).
  4. Hand the captured manifest to a Max session running the `research` skill (Rhea reads the chapter shots and returns one JSON verdict per URL — for a worthy verdict she ALSO returns a full `teardown` recipe derived from the SAME chapters, no re-render).
  5. Parse Rhea's JSON via `extractJson`, validate against the CHECK-constraint vocab, and apply each decision via [[research-urls]] `setUrlClassification` / `setTeardownVerdict` / `setCaptureRef` — plus, for worthy decisions carrying a `teardown`, `setTeardown` (validator-gated; a half-formed recipe is rejected without leaving the row inconsistent — the classification + verdict already landed). `log_tail` includes `teardowns=<landed>/rejected=<n>` so the Phase-2 verification can observe recipe throughput.
- **Skill** — `.claude/skills/research/SKILL.md` (Rhea's persona + output contract + the erthlabs 8-reasons worked teardown example).
- **Write chokepoint** — every `research_urls` mutation flows through [[research-urls]]. The worker never touches the table directly (CI grep enforces).

## The `storefront-optimizer` lane's Cleo blueprint preamble ([[../specs/cleo-lander-blueprint]] Phase 2)

Every `runStorefrontOptimizerJob` invocation runs a **workspace-scoped preamble** before the per-surface diagnose/propose work: [[cleo-blueprint]] `runCleoBlueprintSweep(workspaceId, {createdBy})`. The preamble reads [[research-urls]] `listNewTeardowns` and per row decides **modify-vs-build-new** via [[cleo-blueprint]] `decideBlueprintForTeardown`:

- **Chain:** [[../tables/research_urls]] (teardown recipe) → **[[../tables/lander_blueprints|blueprint]]** → Carrie's `dr-content` job (fills `content`) → Ada build (`build_submitted`).
- **Blueprint path** (whole missing funnel type): [[lander-blueprints]] `createBlueprint` with the teardown's `transferable_pattern` adapted into `skeleton` + a rationale, then enqueue a deduped `dr-content` [[../tables/agent_jobs]] row (spec_slug = blueprint id, kind = `dr-content`) + [[research-urls]] `markTeardownReviewed`.
- **Bandit path** (single reversible lever — we already have a matching-funnel-type lander): NO blueprint. Cleo's existing storefront-optimizer campaign path handles it unchanged; the sweep just marks the teardown reviewed.
- **North-star + idempotence:** deterministic + within Max's leash; every row surfaces its rationale. The `dr-content` dedup gate + `growth_reviewed_at` watermark hold under retries.
- **Non-fatal:** try/caught — a preamble failure never poisons the per-surface optimizer work.

The `dr-content` kind is registered in `Job.kind`; the deterministic worker will add a `runDrContentJob` runner in the Carrie build (Phase 3+ of a follow-up spec).

## Related

[[../lifecycles/agent-todo-system]] · [[agent-jobs]] · [[approval-inbox]] · [[agent-grader]] · [[claude-health]] · [[../inngest/acquisition-research-cadence]] · [[../inngest/research-sensor]] · [[../recipes/lander-capture]] · [[../recipes/lander-teardown]] · [[research-urls]] · [[cleo-blueprint]] · [[lander-blueprints]] · [[../tables/lander_blueprints]] · [[storefront-optimizer-agent]] · [[acquisition-gap-grader]] · [[../operational-rules]]
