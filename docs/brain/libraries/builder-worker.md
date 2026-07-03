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

- **Enqueue** — [[../inngest/acquisition-research-cadence]]'s daily cron: for any ad-tool workspace with `research_urls` rows at `teardown_verdict='unreviewed'`, insert ONE `kind='research'` `agent_jobs` row (dedup-gated on any in-flight `research` job for the workspace — same pattern as `gap-grade`).
- **Cap** — `MAX_RESEARCH=1` concurrency lane, `RESEARCH_TIMEOUT_MS=30 min`, `RESEARCH_BATCH_CAP=8` URLs per pass. Bumping the batch size is a knob (env-tunable), not a code change.
- **`runResearchJob(job)`** (the runner, in `scripts/builder-worker.ts`):
  1. Read the top-N unreviewed `research_urls` for the workspace, biggest `ad_count` first.
  2. Deterministic capture — dynamically import [[../../scripts/research-capture.ts]] and `captureBatch(...)`: mobile Playwright renders + geometric overlay-kill + DOM-first `<section>` chaptering with a vision-tile fallback ([[../recipes/lander-capture]]). Shots go to the private `research-shots` Storage bucket. Runs EXACTLY ONCE per URL (one-session invariant — no second render).
  3. Any URL whose capture returned `unviewable` after retries is marked `classification='unviewable'` deterministically via [[research-urls]] `setUrlClassification` (Rhea never guesses worthiness of a page she couldn't see — `unviewable ≠ not_worthy`).
  4. Hand the captured manifest to a Max session running the `research` skill (Rhea reads the chapter shots and returns one JSON verdict per URL — for a worthy verdict she ALSO returns a full `teardown` recipe derived from the SAME chapters, no re-render).
  5. Parse Rhea's JSON via `extractJson`, validate against the CHECK-constraint vocab, and apply each decision via [[research-urls]] `setUrlClassification` / `setTeardownVerdict` / `setCaptureRef` — plus, for worthy decisions carrying a `teardown`, `setTeardown` (validator-gated; a half-formed recipe is rejected without leaving the row inconsistent — the classification + verdict already landed). `log_tail` includes `teardowns=<landed>/rejected=<n>` so the Phase-2 verification can observe recipe throughput.
- **Skill** — `.claude/skills/research/SKILL.md` (Rhea's persona + output contract + the erthlabs 8-reasons worked teardown example).
- **Write chokepoint** — every `research_urls` mutation flows through [[research-urls]]. The worker never touches the table directly (CI grep enforces).

## Related

[[../lifecycles/agent-todo-system]] · [[agent-jobs]] · [[approval-inbox]] · [[agent-grader]] · [[claude-health]] · [[../inngest/acquisition-research-cadence]] · [[../recipes/lander-capture]] · [[../recipes/lander-teardown]] · [[research-urls]] · [[acquisition-gap-grader]] · [[../operational-rules]]
