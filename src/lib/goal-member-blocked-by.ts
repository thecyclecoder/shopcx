/**
 * pia-decomposition-emits-plain-slug-blocked-by Phase 2 — validate/repair EXISTING goal-member `blocked_by`.
 *
 * Phase 1 fixed Pia's decomposition write-path (`parsePlannerSpecs` in scripts/builder-worker.ts) so a fresh
 * decomposition emits plain member slugs. Phase 2 covers what Phase 1 can't reach: rows already IN the DB
 * (specs authored before the Phase 1 landed, or specs whose `blocked_by` was set outside the Pia path — an
 * operator or a script), and any FUTURE drift. The build-gating in [[libraries/agent-jobs]]
 * (`areSpecsGoalMates` + the Kahn sort at `sequencePromoteCandidates`) looks up each `blocked_by` entry in
 * `public.specs` by exact slug and does NOT split on `:` — a namespaced `goalSlug:specSlug` entry resolves to
 * no spec, and the gate silently treats it as an external blocker (cleared only by shipping), letting the
 * dependent spec build out of order (the 2026-07-07 Sol-goal build shipped its M2 spec before its declared M1
 * blocker for exactly this reason).
 *
 * Two pieces, matching the Phase 2 verification:
 *   1. `diagnoseGoalMemberBlockedBy*` — PURE per-entry / per-list diagnosers over a materialized
 *      `memberSlugs` set. Return one of three verdicts per entry:
 *        - `ok`    — already a plain kebab slug AND a member of this goal (the gate resolves it correctly).
 *        - `repair`— namespaced / wikilinked / anchored, but the normalized form IS a goal-member
 *                   (`normalizePlannerBlockedBySlug` resolves it → we can safely persist the plain slug).
 *        - `flag`  — empty / junk / a slug the goal does NOT contain (cross-goal blocker or drift). Never
 *                   silently repaired — surfaced for human review.
 *   2. `scanGoalBlockedByDrift` / `repairGoalBlockedByDrift` — async wrappers over the specs-table SDK:
 *      read a goal's member specs' `blocked_by` (via `specsForMilestone`) and diagnose / persist. The
 *      repairer follows the mutation-guard rule (Bo coaching): a spec is repaired ONLY when every entry in
 *      its stored list is diagnosed OK-or-REPAIR (no flag entries) AND the DB row's `blocked_by` is still
 *      the exact list we diagnosed (compare-and-set — a stale-read repair can't overwrite a fresh write).
 *      Persisted via `setSpecBlockers` (the sanctioned `specs.blocked_by` writer — CLAUDE.md).
 *
 * Sol-goal repair note: the 2026-07-07 Sol-goal members were fixed by hand. This module is the standing
 * validator + a callable repair path for FUTURE drift, so a re-occurrence is either auto-repaired (when the
 * drift is a normalizable namespace prefix Pia would emit) or flagged (when the entry is genuinely broken).
 *
 * See [[libraries/goal-proposals]] (`normalizePlannerBlockedBySlug` — the Phase 1 write-path normalizer) ·
 * [[libraries/specs-table]] (`specsForMilestone` / `setSpecBlockers`) · [[libraries/agent-jobs]]
 * (`areSpecsGoalMates` — the gate this validator keeps honest).
 */

import { normalizePlannerBlockedBySlug } from "@/lib/agents/goal-proposals";
import { getGoal } from "@/lib/goals-table";
import { specsForMilestone, setSpecBlockers, getSpec, type SpecRow } from "@/lib/specs-table";

/** One entry's diagnosis in a member spec's stored `blocked_by` list. */
export type GoalMemberBlockedByEntryDiagnosis =
  | { status: "ok"; raw: string; plain: string }
  | { status: "repair"; raw: string; plain: string; reason: string }
  | { status: "flag"; raw: string; reason: string };

/** One member spec's diagnosis — the three-way partition of its stored `blocked_by` list. */
export interface GoalMemberBlockedByDrift {
  slug: string;
  /** entries that are already a plain slug AND a member of this goal (the gate resolves them). */
  ok: string[];
  /** entries that normalize to a goal-member — the plain slug the repair would persist. */
  repair: { raw: string; plain: string; reason: string }[];
  /** entries that DON'T resolve to any member of this goal — surfaced, never silently rewritten. */
  flag: { raw: string; reason: string }[];
}

/**
 * Diagnose ONE `blocked_by` entry against a materialized `memberSlugs` set. Pure. Rejects anything
 * that isn't a string, that self-blocks, or that doesn't resolve to a plain kebab slug (`isValidGoalSlug`).
 * A normalizable entry whose plain form IS a member yields `repair` (safe to persist); a normalizable
 * entry whose plain form is NOT a member yields `flag` (cross-goal / drift — surfaced, not repaired).
 */
export function diagnoseGoalMemberBlockedByEntry(
  raw: unknown,
  selfSlug: string,
  memberSlugs: ReadonlySet<string>,
): GoalMemberBlockedByEntryDiagnosis {
  if (typeof raw !== "string") {
    return { status: "flag", raw: String(raw ?? ""), reason: "non-string entry" };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { status: "flag", raw, reason: "empty entry" };
  const norm = normalizePlannerBlockedBySlug(trimmed);
  if (!norm) return { status: "flag", raw: trimmed, reason: "does not resolve to a kebab spec slug" };
  const self = (selfSlug || "").trim().toLowerCase();
  if (norm === self) return { status: "flag", raw: trimmed, reason: "self-block (a spec cannot block itself)" };
  if (trimmed === norm) {
    // Already plain — either a goal-member (the gate resolves it) or a cross-goal / unknown slug.
    if (memberSlugs.has(norm)) return { status: "ok", raw: trimmed, plain: norm };
    return {
      status: "flag",
      raw: trimmed,
      reason: `plain slug "${norm}" is not a member of this goal (cross-goal / unknown — the goal-mate gate cannot resolve it)`,
    };
  }
  // Non-plain form (namespaced / wikilinked / anchored). Only "repair" when the normalized form
  // is a genuine goal-member — otherwise flag (the entry may point at a real spec but not one the
  // goal-mate gate can hold, so silently rewriting to that plain slug would still be wrong).
  if (memberSlugs.has(norm)) {
    return {
      status: "repair",
      raw: trimmed,
      plain: norm,
      reason: `namespaced/malformed "${trimmed}" resolves to goal-member "${norm}" — persist plain slug`,
    };
  }
  return {
    status: "flag",
    raw: trimmed,
    reason: `normalizes to "${norm}" which is not a member of this goal (cross-goal / unknown — needs owner review)`,
  };
}

/**
 * Diagnose a whole stored `blocked_by` list for ONE member spec. Non-arrays / undefined yield an empty
 * drift (no work). Order-preserving dedup within each bucket — a duplicate plain form (e.g. both
 * `[[foo]]` and `foo`) collapses to ONE ok/repair entry.
 */
export function diagnoseGoalMemberBlockedByList(
  list: unknown,
  selfSlug: string,
  memberSlugs: ReadonlySet<string>,
): GoalMemberBlockedByDrift {
  const drift: GoalMemberBlockedByDrift = { slug: selfSlug, ok: [], repair: [], flag: [] };
  if (!Array.isArray(list)) return drift;
  const seenPlain = new Set<string>();
  for (const entry of list) {
    const d = diagnoseGoalMemberBlockedByEntry(entry, selfSlug, memberSlugs);
    if (d.status === "ok") {
      if (!seenPlain.has(d.plain)) {
        seenPlain.add(d.plain);
        drift.ok.push(d.plain);
      }
    } else if (d.status === "repair") {
      if (!seenPlain.has(d.plain)) {
        seenPlain.add(d.plain);
        drift.repair.push({ raw: d.raw, plain: d.plain, reason: d.reason });
      }
    } else {
      drift.flag.push({ raw: d.raw, reason: d.reason });
    }
  }
  return drift;
}

/**
 * The plain-slug list a repair would persist for `drift`: `ok` slugs first (preserved order), then
 * each unique repair's plain slug. Pure. The caller checks `drift.flag.length === 0` before persisting
 * (a flagged list is surfaced, never silently rewritten).
 */
export function repairedBlockedByList(drift: GoalMemberBlockedByDrift): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of drift.ok) if (!seen.has(s)) { seen.add(s); out.push(s); }
  for (const r of drift.repair) if (!seen.has(r.plain)) { seen.add(r.plain); out.push(r.plain); }
  return out;
}

/**
 * Read a goal's members (via `specsForMilestone` over `goal_milestones.id`) and diagnose each member's
 * stored `blocked_by`. Read-only — never mutates. Returns per-spec drift PLUS the materialized
 * `memberSlugs` set the diagnosis ran against (so a caller can render "not a goal-member" reasons).
 * Best-effort per milestone; a fetch failure is logged and the milestone contributes no members.
 */
export interface ScanGoalBlockedByDriftResult {
  goalSlug: string;
  memberSlugs: string[];
  drift: GoalMemberBlockedByDrift[];
}
export async function scanGoalBlockedByDrift(workspaceId: string, goalSlug: string): Promise<ScanGoalBlockedByDriftResult> {
  const goal = await getGoal(workspaceId, goalSlug);
  if (!goal) return { goalSlug, memberSlugs: [], drift: [] };
  const memberRows: SpecRow[] = [];
  for (const m of goal.milestones) {
    try {
      const rows = await specsForMilestone(workspaceId, m.id);
      memberRows.push(...rows);
    } catch (e) {
      console.warn(`[goal-member-blocked-by] specsForMilestone(${m.id}) failed for goal ${goalSlug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const memberSlugs = new Set(memberRows.map((r) => r.slug));
  const drift = memberRows.map((r) => diagnoseGoalMemberBlockedByList(r.blocked_by ?? [], r.slug, memberSlugs));
  return { goalSlug, memberSlugs: [...memberSlugs].sort(), drift };
}

/**
 * Guarded repair of one goal's member `blocked_by` drift. A member is repaired ONLY when:
 *   1. Its scan produced ≥1 `repair` entry (there IS something to fix).
 *   2. Its scan produced ZERO `flag` entries (the whole list is resolvable — never silently
 *      rewrite a list with an unresolved cross-goal / unknown entry).
 *   3. A confirming re-read of `public.specs` shows the row's `blocked_by` is STILL bit-for-bit
 *      the same list we diagnosed (compare-and-set — a fresh write between the scan and the persist
 *      never overwrites). Bo coaching #1 (`security-envelope` / `approval-inbox`): a mutating write
 *      after an async read re-asserts its precondition against current state.
 *
 * Persists the plain list via `setSpecBlockers` (the sanctioned specs-table SDK writer). Best-effort
 * per spec — one spec's failure never blocks the rest. Returns a per-spec outcome list.
 *
 * A spec with flag entries is returned as `skipped_flagged` (surfaced, not repaired). A spec whose
 * stored list changed underneath us is returned as `skipped_stale` (retry on the next pass).
 */
export type GoalMemberRepairOutcome =
  | { slug: string; action: "repaired"; from: string[]; to: string[] }
  | { slug: string; action: "skipped_no_change"; reason: string }
  | { slug: string; action: "skipped_flagged"; flags: { raw: string; reason: string }[] }
  | { slug: string; action: "skipped_stale"; reason: string }
  | { slug: string; action: "failed"; error: string };

export interface RepairGoalBlockedByDriftResult {
  goalSlug: string;
  memberSlugs: string[];
  outcomes: GoalMemberRepairOutcome[];
}

export async function repairGoalBlockedByDrift(workspaceId: string, goalSlug: string): Promise<RepairGoalBlockedByDriftResult> {
  const scan = await scanGoalBlockedByDrift(workspaceId, goalSlug);
  const outcomes: GoalMemberRepairOutcome[] = [];
  for (const d of scan.drift) {
    if (d.flag.length > 0) {
      outcomes.push({ slug: d.slug, action: "skipped_flagged", flags: d.flag });
      continue;
    }
    if (d.repair.length === 0) {
      outcomes.push({ slug: d.slug, action: "skipped_no_change", reason: "no repair entries" });
      continue;
    }
    // Confirming re-read: the diagnosis ran over the scan's snapshot; before we persist, re-read the
    // row and require that the stored list is bit-for-bit what we diagnosed. Any drift between scan
    // and persist punts to `skipped_stale` (the next pass picks it up cleanly).
    try {
      const fresh = await getSpec(workspaceId, d.slug);
      if (!fresh) {
        outcomes.push({ slug: d.slug, action: "skipped_stale", reason: "spec row disappeared between scan and repair" });
        continue;
      }
      const freshList = Array.isArray(fresh.blocked_by) ? fresh.blocked_by : [];
      const freshDrift = diagnoseGoalMemberBlockedByList(freshList, d.slug, new Set(scan.memberSlugs));
      const sameDiagnosis =
        freshDrift.ok.length === d.ok.length &&
        freshDrift.repair.length === d.repair.length &&
        freshDrift.flag.length === d.flag.length &&
        freshDrift.ok.every((s, i) => s === d.ok[i]) &&
        freshDrift.repair.every((r, i) => r.raw === d.repair[i].raw && r.plain === d.repair[i].plain) &&
        freshDrift.flag.every((f, i) => f.raw === d.flag[i].raw);
      if (!sameDiagnosis) {
        outcomes.push({ slug: d.slug, action: "skipped_stale", reason: "blocked_by changed between scan and repair" });
        continue;
      }
      const nextList = repairedBlockedByList(d);
      await setSpecBlockers(workspaceId, d.slug, nextList);
      outcomes.push({ slug: d.slug, action: "repaired", from: freshList, to: nextList });
    } catch (e) {
      outcomes.push({ slug: d.slug, action: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { goalSlug, memberSlugs: scan.memberSlugs, outcomes };
}
