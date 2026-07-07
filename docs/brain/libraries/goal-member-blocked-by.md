# libraries/goal-member-blocked-by

**File:** `src/lib/goal-member-blocked-by.ts`

Validate and (safely) repair a goal's member specs' stored `blocked_by` — the standing companion to [[../specs/pia-decomposition-emits-plain-slug-blocked-by]] Phase 1 (which fixed Pia's write-path so a fresh decomposition emits plain member slugs). Phase 2 covers what Phase 1 can't reach: rows already IN the DB (authored before Phase 1, or set outside the Pia path — an operator or a script) and any FUTURE drift a re-occurrence would introduce.

## Why this exists

The build-gating in [[agent-jobs]] (`areSpecsGoalMates` + the Kahn sort in `sequencePromoteCandidates`) looks each `blocked_by` entry up in [[../tables/specs]] by exact slug and does **NOT** split on `:`. A namespaced `goalSlug:specSlug` entry therefore resolves to no spec — the gate silently treats it as an external blocker (cleared only by shipping), and the dependent spec builds out of order. The 2026-07-07 Sol-goal build shipped `sol-cheap-execution-over-ticket-direction` before its declared blocker `sol-ticket-direction-artifact` for exactly this reason. Phase 2 detects this shape, repairs it when safe, and flags it when not.

## The three-way partition

For every entry in a member spec's stored `blocked_by`, the diagnoser returns one of:

- **`ok`** — already a plain kebab slug **AND** a member of the same goal. The gate resolves it correctly today; no action.
- **`repair`** — namespaced / wikilinked / anchored ([[goal-proposals]] `normalizePlannerBlockedBySlug` resolves it), **AND** the normalized form IS a goal-member. Safe to persist the plain slug; the gate then holds the dependent correctly.
- **`flag`** — empty / junk / a slug the goal does **not** contain (cross-goal blocker, unknown, drift). **Never silently repaired** — surfaced for human review. A namespaced entry whose plain form isn't a goal-member also flags: rewriting to a cross-goal slug would still be wrong.

## Exports

### Pure diagnosers (unit-testable, no I/O)

- **`diagnoseGoalMemberBlockedByEntry(raw, selfSlug, memberSlugs)`** → `{ status: "ok" | "repair" | "flag", ... }`. Rejects non-strings, self-blocks, and entries that don't normalize to a kebab slug (via [[goal-proposals]] `normalizePlannerBlockedBySlug`).
- **`diagnoseGoalMemberBlockedByList(list, selfSlug, memberSlugs)`** → `GoalMemberBlockedByDrift = { slug, ok, repair, flag }`. Order-preserving dedup on the plain form — a namespaced entry AND its plain wikilink collapse to one bucket entry.
- **`repairedBlockedByList(drift)`** → `string[]` — the plain-slug list a persist would write (`ok` slugs first, then each unique repair's `plain`). The caller checks `drift.flag.length === 0` before persisting.

### Async SDK (reads specs + persists via the specs-table SDK)

- **`scanGoalBlockedByDrift(workspaceId, goalSlug)`** → `{ goalSlug, memberSlugs, drift[] }` — read-only. Loads the goal via [[goals-table]] `getGoal`, enumerates members via [[specs-table]] `specsForMilestone` over each milestone id, and returns per-spec drift.
- **`repairGoalBlockedByDrift(workspaceId, goalSlug)`** → `{ goalSlug, memberSlugs, outcomes[] }` — guarded write. A member is repaired **only** when it has ≥1 repair entry AND ZERO flag entries AND a confirming re-read shows the DB's `blocked_by` is bit-for-bit the list the scan diagnosed (compare-and-set). Persisted via [[specs-table]] `setSpecBlockers` — the sanctioned `specs.blocked_by` writer (CLAUDE.md: "Database is the spec" / specs-status-override-only).

Per-spec outcomes:

| action | meaning |
|---|---|
| `repaired` | plain list persisted; `from` / `to` captured |
| `skipped_no_change` | no repair entries — nothing to do |
| `skipped_flagged` | ≥1 flag entry — surfaced for human review, never silently rewritten |
| `skipped_stale` | confirming re-read showed the row's `blocked_by` changed between scan and persist — retry on the next pass |
| `failed` | DB error persisting the plain list |

## Safety invariants

- **Never rewrite a flagged list.** A single `flag` entry poisons the whole member's repair — the whole list is surfaced instead. The dependent spec's ordering can't be silently swapped by rewriting a cross-goal slug to a same-name goal-member.
- **Compare-and-set on persist.** After scanning, the repairer re-reads the row and requires the stored `blocked_by` to still be bit-for-bit the diagnosed list. Any drift punts to `skipped_stale`. This follows the Bo-coaching mutation-guard rule — a stale async read never overwrites a fresh write. See [[agent-jobs]] Phase-2 mutation guards (`approval-inbox` `.eq("status", ...)` compare-and-set at `runProposedGoalJob` resume).
- **SDK-only writes.** All `specs.blocked_by` writes go through [[specs-table]] `setSpecBlockers` — the `_check-pm-sdk-compliance` lint enforces this (no raw PM SQL outside the SDK).
- **Read-only by default.** The scanner never mutates; the repairer is a separate, explicit call. A caller can `scan` in a periodic pass and only `repair` on operator approval.

## Related

- [[../specs/pia-decomposition-emits-plain-slug-blocked-by]] — the spec; Phase 1 (write-path normalizer in `parsePlannerSpecs` at `scripts/builder-worker.ts`) + Phase 2 (this module).
- [[goal-proposals]] — `normalizePlannerBlockedBySlug` / `normalizePlannerBlockedByList` (Phase 1 pure normalizers, reused by this module).
- [[specs-table]] — `specsForMilestone`, `setSpecBlockers`, `getSpec` (the SDK writers/readers this module composes).
- [[goals-table]] — `getGoal` + `goal_milestones` join.
- [[agent-jobs]] — `areSpecsGoalMates` + `sequencePromoteCandidates` (the gate this validator keeps honest).
- [[platform-director]] — `findMilestoneSequenceViolations` / `reconcileMilestoneSequence` (a related reactive gate that acts AFTER an out-of-order fan-out; this module is the DB-level PRE-check on stored `blocked_by`).
