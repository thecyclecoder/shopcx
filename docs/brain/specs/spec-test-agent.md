# Spec-Test Agent (box QA over shipped-unverified specs) 🚧

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform" (box-agent family with [[box-spec-chat]] · [[box-ticket-improve]] · [[box-escalation-triage]]). Fills the **Shipped → Verified** gap in [[../project-management]].

A box agent that **tests shipped-but-unverified specs against their own `## Verification` checklist** and reports what passed, what failed, and **what still needs a human** — so the owner's "Mark verified & archive" decision is fast and evidence-backed instead of a manual re-test of every shipped feature. It **never** auto-verifies (that human gate stays) and **never** mutates prod — it runs only non-destructive checks and surfaces the rest.

**Outcome:** a shipped spec arrives at the verify gate pre-tested: "8/10 auto-checks ✅, 1 ✗ (looks broken — here's the evidence), 1 👤 needs you to eyeball the page." The owner verifies in seconds, or sees a real regression before archiving.

## Why this fits
[[../project-management]]: **Shipped (✅)** = the build deployed the code (automated). **Verified** = the owner tested it in prod and it works (human, owner-only, *never* automated). The gap is a list of "live but not yet prod-verified" specs sitting in the board's "Shipped — awaiting verification" column, each with a `## Verification` checklist the build wrote. The agent executes the *automatable* bullets of that checklist so the human only does the parts that genuinely need them.

## Trigger + scope
- **Daily Inngest cron** (`spec-test-cron`, the [[../inngest/triage-escalations]] enqueue precedent) finds specs that are **shipped but not archived** — derived status `shipped` ([[../libraries/brain-roadmap]] `deriveStatus`) AND the spec file still in `docs/brain/specs/` (no `archive.d/{slug}.md`) — and inserts a `kind='spec-test'` [[../tables/agent_jobs]] job per such spec (deduped: skip specs with a fresh passing run or an open job). Also on-demand: a **"Test now"** button on the shipped spec card.
- Concurrency-1 `MAX_SPEC_TEST` lane on the box.

## What it does (per spec, on Max)
A top-level `claude -p` on Max (web search on, no `ANTHROPIC_API_KEY`) in a repo checkout reads the spec + its `## Verification` bullets and, for each bullet, **classifies then acts**:
- **Auto-testable (non-destructive) → run + record ✅/✗ with evidence:** code/`Grep`/`Read` assertions ("route X exists / column Y selected"), **DB-state reads** (probe the table/row the bullet names), **GET / read-only API** calls, migration-applied probes, `tsc`/build/config presence, **role/RLS checks** (e.g. "as viewer → 403"). Each verdict carries the concrete evidence (the query result, the HTTP status, the file:line).
- **Needs human → flag, never execute:** anything **visual/UX** ("looks right", "renders the badge", "the page looks fantastic"), or any check that would **mutate prod** (send a message, place an order, charge a card, fire a real email/SMS) — these are surfaced as "needs human testing," not run.
- **Inconclusive → flag** (couldn't determine without a side effect or missing fixture).

## 🚨 Guardrails (supervisable autonomy)
- **Read-only / non-destructive ONLY.** The agent never writes prod, never sends a customer message/email/SMS, never creates an order, never flips a spec to verified. It optimizes a bounded proxy — "the automatable checks pass" — and the **human owns the verify decision**. Reaches prod through read-only deterministic tools (DB reads, GET endpoints); any mutating verification path is auto-classified human-only.
- **It stamps, it doesn't gate.** The agent **never** marks a spec verified or archives it (that owner-only gate stays untouched). But it **applies its own "stamp of approval"** — an `agent_verdict` on the run: **`approved`** when zero auto-checks failed (its non-destructive coverage passed), **`issues`** when something auto-failed, plus a separate "human checks pending" flag. The stamp is a distinct **"Agent-tested ✅"** badge next to (not replacing) the human **Verified** state — a CEO→role→tool signal that "the bot checked the automatable parts and they hold," which the owner then confirms.
- **An auto-✗ on a shipped spec is high-signal** (the feature shipped but fails its own verification = a regression or an incomplete build) — surface it loudly; (stretch) propose a fix spec via the [[box-spec-chat]] finalize path rather than silently.

## Tooling on the box (this agent needs broad read access — runs ON the box)
The agent **must run on the remote box** (it's where the toolchain + creds live; never a Vercel function). Its non-destructive QA toolkit, all on the box:
- **Repo** — the working checkout for `Read`/`Grep`/`Glob` + `tsc`/build (does the route/column/component the bullet names actually exist + compile).
- **GitHub** (`gh` CLI + `GITHUB_TOKEN`, already on the box) — read PR/commit/**CI check** status for the spec's build, confirm the merge landed.
- **Vercel CLI** (`vercel` + a read-scoped `VERCEL_TOKEN`) — confirm the deploy that should carry the feature is **READY**, read **build + runtime logs** (catch a route 500ing in prod), check **env-var presence** (`vercel env ls`), and resolve the prod/preview URL to hit. **Provisioning:** install the Vercel CLI on the box + add `VERCEL_TOKEN` to the worker env (`/root/shopcx-worker.env`); `gh`/`GITHUB_TOKEN` already present ([[../recipes/build-box-setup]]).
- **Prod DB (read-only)** — service-role **reads** to probe the table/row/column a bullet asserts (never writes).
- **HTTP** — **GET / read-only** endpoint hits (prod + Vercel preview URL) for status/shape; role/RLS checks (expect 403 as a viewer).
- **WebSearch** when a check needs external context.
All read-only / non-destructive (see guardrails). The box keeps its secrets for this agent (unlike a code-build, which is secret-stripped) — it needs them to inspect prod — but the agent is constrained to reads.

## Data + surfacing
- **`spec_test_runs`** (new table): `id, workspace_id, spec_slug, run_at, agent_verdict (approved｜issues｜needs_human), summary {auto_pass, auto_fail, needs_human, inconclusive}, checks jsonb [{text, verdict: pass｜fail｜needs_human｜inconclusive, evidence}], transcript`. One row per run; latest wins.
- **Primary surface — a `Developer` sidebar section with a `Spec Tests` (QA) page** (`/dashboard/developer/spec-tests`): the agent's report home — every shipped-unverified spec with its latest run: the **"Agent-tested ✅ / ⚠️ issues"** stamp, the auto pass/fail/needs-human counts, each check's verdict + evidence (expandable), and an aggregated **"Needs human testing"** list across all specs. A **"Test now"** button per spec. (New top-level `Developer` nav group — house future dev/QA tools here too.)
- **Roadmap board:** each "Shipped — awaiting verification" card gets a compact **test chip** (`✅ 8 · ✗ 1 · 👤 1`) + the **Agent-tested** stamp, linking to the Developer page.
- **VerificationCard** (`src/app/dashboard/roadmap/VerificationCard.tsx`, beside "Mark verified & archive"): render each checklist bullet with its auto-verdict + evidence inline + a distinct **"Needs human testing"** list — so the owner does only those, then verifies.

## Verification
- On the box, apply the migration (`npx tsx scripts/apply-spec-test-runs-migration.ts`) → expect `✓ spec_test_runs table present: true`; re-running it is a no-op (idempotent `IF NOT EXISTS`).
- In the dashboard sidebar (as owner), open **Developer → Spec Tests** (`/dashboard/developer/spec-tests`) → expect a page listing every shipped-but-unverified spec, each with a **Test now** button; non-owners don't see the nav item (owner-gated). A spec not yet tested shows "not yet tested".
- On a shipped spec's Spec Tests row, click **Test now** → expect a `POST /api/roadmap/spec-test` returning `{queued:true}` and a `kind='spec-test'` row inserted in `agent_jobs`; clicking again while it's in flight returns `{queued:true, already:true}` (no duplicate job).
- After the box runs the job (or `npx tsx scripts/builder-worker.ts` claims it), query `select agent_verdict, summary, jsonb_array_length(checks) from spec_test_runs order by run_at desc limit 1` → expect one row whose `summary` counts match the `checks` length and `agent_verdict` ∈ `approved|issues|needs_human` (re-derived from checks: `issues` iff any check is `fail`).
- On `/dashboard/roadmap`, a shipped card with a run → expect the compact **Agent-tested** stamp + `✅·✗·👤·?` chip linking to the Spec Tests page; on `/dashboard/roadmap/{slug}` the VerificationCard shows per-bullet verdicts with expandable evidence + a distinct **👤 Needs human testing** list.
- On the box, `npx tsx scripts/spec-test-db-probe.ts "select 1"` → expect JSON rows; `npx tsx scripts/spec-test-db-probe.ts "update spec_test_runs set agent_verdict='x'"` → expect it to refuse (read-only: rejects non-SELECT / mutating keywords) and exit non-zero.
- Confirm the cron is registered: `grep specTestCron src/app/api/inngest/route.ts` → present; the function id is `spec-test-cron` with cron `45 10 * * *`.
- Negative: a run never sends a message / creates an order / charges a card (mutating bullets are recorded `needs_human`, not executed); the agent never flips a spec to verified or writes to `archive.d/` — the owner's **Mark verified & archive** gate is untouched. API console stays flat (Max, no `ANTHROPIC_API_KEY`).

## Phase 1 — sweep + auto-checks + report ✅
`spec-test` job kind + `MAX_SPEC_TEST` lane + `runSpecTestJob`; box provisioning (install Vercel CLI + `VERCEL_TOKEN` in the worker env; `gh`/`GITHUB_TOKEN` already there); the `spec-test` skill (classify + **non-destructive** execution of `## Verification` bullets using the box toolchain — repo/`tsc`, `gh` CI, `vercel` deploy+logs+env, DB reads, GET endpoints); `spec_test_runs` table with the `agent_verdict` stamp; the daily cron; the new **`Developer → Spec Tests`** page; and the board test-chip + Agent-tested stamp + VerificationCard per-bullet verdicts. "Test now" on-demand button.

## Phase 2 — human-test queue + regression escalation ⏳
A "Needs human testing" queue (like [[improve-queue]]) aggregating all pending human checks across shipped specs; auto-`fail`s optionally propose a fix spec via [[box-spec-chat]] / route into [[box-escalation-triage]]-style handling.

## Brain updates (same PR)
[[../tables/agent_jobs]] (`spec-test` kind/lane) · new `spec_test_runs` table page · new `spec-test-cron` inngest page · [[../project-management]] (the Shipped→Verified gap now pre-tested + the Agent-tested stamp vs human Verified) · new `Developer` dashboard section + [[../dashboard/roadmap]] (test chip/stamp + VerificationCard verdicts) · [[../recipes/build-box-setup]] (new lane + Vercel CLI / `VERCEL_TOKEN` provisioning) · the `spec-test` skill page. Fold on ship.
