# Platform / Engineering (function)

The permanent owner of **the build system and the product engineering itself** — the autonomous build pipeline, the AI-agent platform, dev tooling/skills, the spec process, and store-tech integrations. The **CTO/Engineering seat on the [[../goals/ceo-mode|CEO-mode]] executive team** — a peer of the business directors (Growth/CMO/Retention/CFO/Logistics/CS), all reporting to the CEO. It's distinguished not by *rank* but by *kind of work*: the business directors **run** the Superfoods business; Platform **builds** ShopCX-as-software (the engine every other director's specs ship through). Peer in rank, keystone in sequence — automating the builder first compounds across every function, which is why Platform was the first function to go fully autonomous (Ada).

> **CEO directive 2026-06-29 — Ada / Platform / DevOps is the SOLE builder.** Build/execution authority belongs to Ada for **EVERY** spec, **ALL** departments, **permanently**. Department directors NEVER drive builds — they OPERATE their own software + AUTHOR specs for the tools they need. A spec's `owner` is the requesting/operating department (attribution + where the finished tool's operation lives); it does NOT determine the build driver. Build-driving is **decoupled** from the org-chart walk: `specDriver`/`platformDrivesSpec` ([[../libraries/platform-director]]) return `platform` whenever Platform is live+autonomous, for any owner — else the CEO (fail-safe). A department going live+autonomous gives it *operational* autonomy only; it does **not** move build-driving off Ada.

## Scope + owned metrics

- **Owns:** the [[../specs/roadmap-build-console|roadmap build console]] + box worker, build approval gates, the [[../specs/goal-decomposition-engine|goal-decomposition engine]], the repo skills catalog, the spec lifecycle/archival process, and Shopify/store-tech tooling.
- **North-star metrics:** specs shipped per week, build success rate, time idea→merged-PR, tsc/CI green.

## Mandates (perpetual)

### Autonomous build platform {#build}
Idea → spec → autonomous build → merged PR, phone-first, on the Max subscription — and keep making that loop faster, safer, and more capable.
- **Metric:** idea→merge cycle time, build success rate, human-touch per build trending down.
- **Specs:** [[../specs/roadmap-build-console]] ✅ · [[../specs/build-approval-gates]] ✅ · [[../specs/goal-decomposition-engine]] ✅ · **repo-skills-catalog** ✅ (verified + archived → [[../recipes/README]]) · [[../specs/spec-fold-from-db-row]] ✅ (verified + archived → [[../project-management]]) · [[../specs/spec-lifecycle-and-archival]] ⏳

### Store tech / Shopify
AI-driven management of the live Shopify store + theme from inside ShopCX.
- **Specs:** **shopify-theme-via-shopcx** ✅ (verified + archived → [[../recipes/edit-shopify-theme]])

### Infra & DevOps / reliability
The "actually improve the system" work — the build box + worker ([[../recipes/build-box-setup]]), deploys, CI/tsc gates, and reliability of the platform itself. (Folded into Platform rather than a separate function; promote to its own function only if the surface grows.)
- **Metric:** build/deploy success rate, green CI, box uptime.

### Platform security {#security}
Keep merged and pre-merge diffs free of introduced vulnerabilities. The security agent reviews every merged diff (and each pre-merge preview) for genuine vulnerabilities and authors a scoped fix-spec when it finds one — parented HERE. Distinct from reliability (uptime/CI) — this mandate owns "the code we ship isn't exploitable."
- **Metric:** vulnerabilities caught pre-ship, time-to-close on a flagged vuln, zero known-vuln merges on main.

## What the live director (Ada) does autonomously — the leash

The mandates above are the function **charter** (the perpetual scope). What the **live Platform/DevOps Director** actually does *without asking* is narrower + concrete — her **leash** ([[../libraries/platform-director]] `LEASH_CATEGORIES` + the escort/grade/coach surfaces), surfaced on her profile as "What she does autonomously" (`DirectorAutonomy`, [[../specs/worker-grading-and-director-management]] P5):

- **Auto-approves within the leash:** an `error_fix`, a `db_health` fix, an `additive_migration`, and a **migration + its idempotent backfill bundle** (`additive_backfill`, P8) — each only after a read-only investigation confirms it's sound (never rubber-stamps).
- **Drives work:** escorts approved goals through their milestones; board-grooming continues/splits in-flight specs; queues 0-phase authored fix specs (`escortFixSpecs`).
- **Grades + coaches — ONLY the workers in her charge** ([[../specs/director-grades-only-own-charge]], [[../operational-rules]] § North star "a supervisor owns the layer below IT"): Ada grades the PLATFORM-owned workers (build/fold/spec-test/repair/pr-resolve/security-review/spec-review/plan/dev-ask/spec-chat/coverage-register/db_health/deploy-guardian/mario) 1–10 ([[../tables/agent_action_grades]]) and coaches a slip. She does NOT reach across departments — `ticket-improve` (CS/Sol), `ticket-analyze` (CS/Cora), `product-seed` (CMO/Piper), `migration-fix` (Retention/Mira), `storefront-optimizer` (Growth) stay UNGRADED until each department's own director's sweep goes live. (`triage-escalations` is NOT a worker rubric at all — it is June's OWN CS-Director escalation triage, a director-tier component graded by the **CEO** via the director-grader `cs_director_call` dimension, not by any worker sweep.) Same owner-scoping [[../libraries/approval-inbox]] `ownerFunctionForKind` already enforces on approvals. Implementation: [[../libraries/agent-grader]] `gradeableKindsForFunction(PLATFORM)`.

### Ada's platform-worker charge (org-chart placement) {#charge}

The workers who report to Ada and answer to her supervision. Every entry lands here + in [[../../src/lib/agents/personas.ts]] (persona + avatar) + in [[../../src/lib/control-tower/registry.ts]] `MONITORED_LOOPS` (org-chart placement + owner:'platform' inheritance) — the three-file wiring for a worker to appear under Ada on the dashboard's org-chart view.

- **Bo (build)** — claims queued build jobs, builds phase-by-phase on the box, keeps tsc clean, opens `claude/*` PRs.
- **Vera (spec-test)** — verifies shipped specs against live prod state; flags false-✅ + drift back to the owning function.
- **Vale (spec-review)** — the quality gate ahead of the build pipeline: reviews every new/flagged spec against the authoring guidelines; nothing builds until she clears it.
- **Rafa (repair)** — triages every Control Tower error signature, root-causes, dismisses noise, authors the fix.
- **Remi (regression)** — reviews every regression alert; dismisses false/flaky, authors fix specs for the real ones.
- **Vault (security-review)** — autonomous security pass on every merged diff (injection / secret-leak / authz / RLS / unsafe admin-client); escalates, never auto-mutates. Also runs the daily CVE dep-watch.
- **Pia (plan)** — decomposes goals into milestone→spec trees with `blocked_by` deps; every leaf spec has an owner + parent (no orphans).
- **Dex (dev-ask)** — answers read-only "why / how / is it working" developer questions from the message center; never mutates.
- **Sage (spec-chat)** — answers authoring questions on a spec + turns the chat into concrete spec edits; keeps the roadmap accurate.
- **Cole (coverage-register)** — catches loops/jobs running unregistered in the Control Tower; proposes the `MONITORED_LOOPS` registry entry (or an exemption).
- **Devi (db_health)** — watches slow queries + table growth; EXPLAIN-diagnoses; proposes the index/migration that fixes it.
- **Pax (pr-resolve)** — resolves dirty/conflicted PRs, dedupes overlapping branches, keeps the merge queue clean.
- **Fenn (fold)** — folds every fully-shipped owner-verified spec into the brain + archives; keeps the brain canonical.
- **Reese (spec-drift)** — the DB-vs-code backstop: for every phase the DB marks shipped, confirms the code is actually on main + surfaces a bad/reverted merge.
- **Reva (deploy-guardian)** — watches each auto-merged deploy over its canary window → healthy/regressed/unsure verdict; auto-reverts a clear deploy-correlated regression, escalates the ambiguous.
- **Mario (pipeline plumbing)** — reactive stall detection + non-destructive live fix + durable fix-spec authoring; reports to Ada; supervised by CEO. Fired by [[../inngest/mario-stall-cron]] on a genuinely stalled spec (the M3 legit-wait discriminator in [[../libraries/mario]] drops uncleared-blocker / wait-status / folded/deferred rows first). Investigates read-only (timecard + blockedBy + live agent_jobs row), applies ONE non-destructive live fix from a bounded vocabulary (`redrive_dropped_job` / `unstick_stale_status` / `release_cleared_blocker` / `requeue_unclaimed_job` / `queue_box_restart`), authors a critical `auto_build` fix-spec for the recurring class, and self-tunes `mario_thresholds` on a false trigger. Conservative default: on ambiguity, escalate — never guess a mutation. Kill-switch: `MARIO_AUTONOMY_MODE` (live / surface_only / off). Loop-guard: ≥3 mario_fired rows for the same slug in 24h escalates 'oscillation risk' instead of firing a fourth fix.
- **Always escalates to the CEO:** anything destructive/irreversible, a new feature or goal, a non-binary choice, or anything she can't confirm sound.

## Owned / contributed goals

- **Centralized Commerce SDK** ✅ (folded → [[../lifecycles/commerce-sdk]]) — one internal-aware `src/lib/commerce` layer for every customer-facing commerce read & write. M1–M4 shipped: the two critical money bugs closed, the SDK core + money resolver ([[../libraries/pricing]]) landed, the differential harness proved zero `$NaN`/`$0`, and the dashboard/agent/AI/ticket surfaces migrated. M5 (customer-portal migration, LAST) remains the open final domino.
- **Mario — reactive pipeline plumbing** ✅ (folded → [[../lifecycles/mario-pipeline-plumbing]]) — no spec silently stalls. M1–M5 shipped: the [[../tables/spec_timecard_events]] ledger + [[../libraries/spec-timecards]] SDK (M1/M2), the [[../inngest/mario-stall-cron]] outlier detector + self-owned [[../tables/mario_thresholds]] (M3), the Mario box agent ([[../libraries/mario]] `applyBoxMario` — live fix + `auto_build` fix-spec + threshold self-tune, [[../../.claude/skills/mario/SKILL.md]]) (M4), and the spec-detail timecard timeline (M5). Mario is now a live worker under Ada (charge list above).
- Enables every other function — the build platform is what turns their specs into shipped code. Underpins [[../goals/ceo-mode]] (the engine that ships the capability-gap specs the CEO surfaces).

## Status

Charter doc. Owns the autonomous build platform + store-tech tooling.
