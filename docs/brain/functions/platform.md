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

## What the live director (Ada) does autonomously — the leash

The mandates above are the function **charter** (the perpetual scope). What the **live Platform/DevOps Director** actually does *without asking* is narrower + concrete — her **leash** ([[../libraries/platform-director]] `LEASH_CATEGORIES` + the escort/grade/coach surfaces), surfaced on her profile as "What she does autonomously" (`DirectorAutonomy`, [[../specs/worker-grading-and-director-management]] P5):

- **Auto-approves within the leash:** an `error_fix`, a `db_health` fix, an `additive_migration`, and a **migration + its idempotent backfill bundle** (`additive_backfill`, P8) — each only after a read-only investigation confirms it's sound (never rubber-stamps).
- **Drives work:** escorts approved goals through their milestones; board-grooming continues/splits in-flight specs; queues 0-phase authored fix specs (`escortFixSpecs`).
- **Grades + coaches — ONLY the workers in her charge** ([[../specs/director-grades-only-own-charge]], [[../operational-rules]] § North star "a supervisor owns the layer below IT"): Ada grades the PLATFORM-owned workers (build/fold/spec-test/repair/pr-resolve/security-review/spec-review/plan/dev-ask/spec-chat/coverage-register/db_health) 1–10 ([[../tables/agent_action_grades]]) and coaches a slip. She does NOT reach across departments — `ticket-improve`/`triage-escalations` (CS/Tilly), `product-seed` (CMO/Sol), `migration-fix` (Retention/Mira), `storefront-optimizer` (Growth) stay UNGRADED until each department's own director's sweep goes live. Same owner-scoping [[../libraries/approval-inbox]] `ownerFunctionForKind` already enforces on approvals. Implementation: [[../libraries/agent-grader]] `gradeableKindsForFunction(PLATFORM)`.
- **Always escalates to the CEO:** anything destructive/irreversible, a new feature or goal, a non-binary choice, or anything she can't confirm sound.

## Owned / contributed goals

- **Centralized Commerce SDK** ✅ (folded → [[../lifecycles/commerce-sdk]]) — one internal-aware `src/lib/commerce` layer for every customer-facing commerce read & write. M1–M4 shipped: the two critical money bugs closed, the SDK core + money resolver ([[../libraries/pricing]]) landed, the differential harness proved zero `$NaN`/`$0`, and the dashboard/agent/AI/ticket surfaces migrated. M5 (customer-portal migration, LAST) remains the open final domino.
- Enables every other function — the build platform is what turns their specs into shipped code. Underpins [[../goals/ceo-mode]] (the engine that ships the capability-gap specs the CEO surfaces).

## Status

Charter doc. Owns the autonomous build platform + store-tech tooling.
