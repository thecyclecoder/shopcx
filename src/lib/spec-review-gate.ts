/**
 * spec-review-gate — the DETERMINISTIC spec-review gate that replaces the Vale LLM lane at the authoring
 * chokepoint ([[../specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]] Phase 1).
 *
 * The Vale checklist is purely MECHANICAL — contiguous `Phase N` sequence, an Owner slug that resolves to
 * a `docs/brain/functions/` page, a Parent that resolves to a real mandate/milestone in the DB, Blocked-by
 * slugs that resolve and are acyclic, a `### Verification` block on every phase, and a companion data-tool
 * plan when a `customer_id`-referenced table is being introduced. Running that checklist through a
 * non-deterministic LLM produced the 2026-07-11 flake pair (Vale passed one director spec and failed an
 * identical one on the SAME missing-intent rule). This module crystallizes the checklist into a pure
 * predicate that runs at author time and rejects a malformed spec on the spot with the EXACT failure
 * named — cheaper, instant, flake-free.
 *
 * Two-layer split — the classic pattern the existing gates already use:
 *  - `computeSpecReviewProblems(input, ctx)` — PURE predicate. No I/O. Given the write payload plus a
 *    pre-resolved context (function slugs on disk, known spec + goal + mandate identifiers, the graph
 *    edges needed for the cycle check), returns the list of human-readable problems (empty when the spec
 *    is well-formed). Exported so it can be unit-tested without a Supabase client or a `docs/` scan.
 *  - `assertSpecReviewGate(workspaceId, input)` — ASYNC wrapper. Materializes the context by scanning
 *    `docs/brain/functions/` + reading `public.specs` + `public.goals` + `public.goal_milestones` via the
 *    existing SDKs, then calls the pure predicate. On problems it throws `SpecReviewGateError` with the
 *    named defects (same fail-loud rail as `MissingVerificationError` / `MissingIntentError` /
 *    `InvalidParentError` in [[author-spec]]).
 *
 * Wiring: [[author-spec]] `authorSpecRowStructured` + `authorSpecRowFromMarkdown` call
 * `assertSpecReviewGate` after the existing shape gates (verification / intent / body / parent shape) and
 * before `upsertSpec`. Vale's LLM lane (Phase 2 of the parent spec — [[../specs/spec-review-agent]]) is
 * retired in the next phase; this Phase 1 lands the deterministic replacement.
 */
import { promises as fs } from "fs";
import path from "path";
import { getAllSpecs, type SpecRow } from "@/lib/specs-table";
import { listGoals, type GoalRow } from "@/lib/goals-table";
import { resolveFunctionMandates } from "@/lib/function-mandates";

const FUNCTIONS_DIR = path.join(process.cwd(), "docs", "brain", "functions");

/**
 * The spec + phases the pure predicate reads. Mirrors the `SpecRowInput` + `SpecPhaseInput` fields
 * the caller (`authorSpecRowStructured` / `authorSpecRowFromMarkdown`) has already coerced — no
 * dependency on the raw markdown or the SDK-write shape.
 */
export interface SpecReviewGateInput {
  slug: string;
  owner: string;
  parent: string;
  parent_kind?: "function" | "mandate" | "milestone" | null;
  parent_ref?: string | null;
  blocked_by: string[];
  /** Bound milestone id (goal-planner path). Present ⇒ the parent resolves through the FK, not the prose. */
  milestone_id?: string | null;
  phases: Array<{ position: number; title: string; body: string; verification: string | null }>;
}

/**
 * The pre-resolved data the pure predicate needs to decide "resolves" checks without hitting disk / DB
 * itself. Materialized once per author call by `assertSpecReviewGate`; small enough to hand into a unit
 * test as literal Sets/Maps.
 */
export interface SpecReviewGateContext {
  /** Bare function slugs present under `docs/brain/functions/{slug}.md`. Owner resolution reads this. */
  knownFunctionSlugs: Set<string>;
  /** Every spec slug in the workspace (Blocked-by resolution + cycle detection). */
  knownSpecSlugs: Set<string>;
  /** slug → its `blocked_by` list. Used to detect a cycle that includes THIS spec's slug transitively. */
  blockedByGraph: Map<string, string[]>;
  /** Typed parent resolution — mandate keys like `platform#build`, lowercased. Populated for functions
   *  whose charter declares a `## Mandates` section (via [[function-mandates]] `resolveFunctionMandates`). */
  knownMandateRefs: Set<string>;
  /** Typed parent resolution — every `goal_milestones.id` in the workspace. */
  knownMilestoneIds: Set<string>;
  /** Untyped-prose parent resolution — goal slug → its milestone anchor slugs (kebab-case of the title). */
  knownGoalMilestones: Map<string, Set<string>>;
}

/**
 * Thrown by `assertSpecReviewGate` when the deterministic checklist fails at authoring. Same fail-loud
 * pattern as `MissingVerificationError` / `MissingIntentError` / `InvalidParentError` — the caller's
 * catch in [[author-spec]] re-throws AS-IS so a downstream `instanceof SpecReviewGateError`
 * discriminator (e.g. the request-fix route) survives.
 */
export class SpecReviewGateError extends Error {
  constructor(
    public readonly slug: string,
    public readonly problems: string[],
  ) {
    super(
      `spec ${slug} failed the spec-review gate: ${problems.join("; ")}. Every check is mechanical — fix ` +
        `the named defect(s) and re-author. (retire-vale-spec-review-becomes-deterministic-authoring-gate Phase 1)`,
    );
    this.name = "SpecReviewGateError";
  }
}

/** Strip a `[[../functions/{slug}]]` wikilink wrapper to the bare slug. */
function toBareFunctionSlug(owner: string): string {
  const raw = (owner || "").trim();
  const wl = raw.match(/^\[\[\.\.\/functions\/([a-z0-9-]+)\]\]$/i);
  if (wl) return wl[1].toLowerCase();
  return raw.replace(/^\[\[|\]\]$/g, "").toLowerCase();
}

/** Kebab-case, matching `function-mandates.kebabize`. */
function kebabize(s: string): string {
  return (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * PURE predicate. Given the write payload + a pre-resolved context, return the deterministic
 * spec-review defects (empty when the spec passes the checklist). The messages mirror the vocabulary
 * Vale surfaced in her `defects[]` — `Phase 1 appears twice`, `no **Owner:** line`,
 * `Parent does not resolve`, `Blocked-by [[x]] does not resolve`, `customer_id table with no data-tool
 * plan`, `Phase 2 has no ### Verification block` — so the failure the CEO / an operator reads is the
 * SAME string Vale would have written, minus the LLM flake.
 *
 * Only the checks NOT already enforced by the existing chokepoint gates
 * (`assertEveryPhaseHasVerification` / `assertEveryNodeHasIntent` / `assertEveryPhaseHasBody` /
 * `assertValidParent`) live here — this gate is the DELTA that closes Vale's coverage. Verification is
 * still re-asserted here so the aggregate "did this spec pass Vale's checklist?" verdict remains
 * self-contained + testable.
 */
export function computeSpecReviewProblems(
  input: SpecReviewGateInput,
  ctx: SpecReviewGateContext,
): string[] {
  const problems: string[] = [];

  // 1. Owner — resolves to a `docs/brain/functions/{slug}.md` page.
  const ownerSlug = toBareFunctionSlug(input.owner);
  if (!ownerSlug) {
    problems.push("no **Owner:** line");
  } else if (!ctx.knownFunctionSlugs.has(ownerSlug)) {
    problems.push(
      `Owner \`[[../functions/${ownerSlug}]]\` does not resolve to a \`docs/brain/functions/\` page`,
    );
  }

  // 2. Phase-heading contiguity — positions must form the contiguous sequence 1..N with no dupes.
  const positions = input.phases.map((p) => p.position);
  const positionCounts = new Map<number, number>();
  for (const pos of positions) positionCounts.set(pos, (positionCounts.get(pos) ?? 0) + 1);
  for (const [pos, count] of positionCounts) {
    if (count > 1) problems.push(`Phase ${pos} appears ${count === 2 ? "twice" : `${count} times`}`);
  }
  const expectedCount = input.phases.length;
  for (let i = 1; i <= expectedCount; i++) {
    if (!positionCounts.has(i)) {
      problems.push(`Phase ${i} is missing — phases must be a contiguous 1..N sequence`);
    }
  }
  // A phase whose position falls OUTSIDE 1..N is out-of-order (mangled `P1/P2/P1/P2` shape).
  for (const pos of positionCounts.keys()) {
    if (pos < 1 || pos > expectedCount) {
      problems.push(`Phase ${pos} is out-of-order — phases must be a contiguous 1..N sequence`);
    }
  }

  // 3. Verification per phase — re-asserted here so the aggregate verdict is self-contained.
  for (const p of input.phases) {
    if (!p.verification || !p.verification.trim()) {
      problems.push(`Phase ${p.position} has no \`### Verification\` block`);
    }
  }

  // 4. Parent resolves — typed (parent_kind/parent_ref or bound milestone_id) OR untyped prose.
  if (input.milestone_id) {
    if (!ctx.knownMilestoneIds.has(input.milestone_id)) {
      problems.push(`Parent milestone \`${input.milestone_id}\` does not resolve to a goal_milestones row`);
    }
  } else if (input.parent_kind === "mandate" && input.parent_ref) {
    if (!ctx.knownMandateRefs.has(input.parent_ref.toLowerCase())) {
      problems.push(`Parent mandate \`${input.parent_ref}\` does not resolve to a function mandate`);
    }
  } else if (input.parent_kind === "milestone" && input.parent_ref) {
    if (!ctx.knownMilestoneIds.has(input.parent_ref)) {
      problems.push(`Parent milestone \`${input.parent_ref}\` does not resolve to a goal_milestones row`);
    }
  } else {
    // Untyped path — parse the prose. `assertValidParent` in [[author-spec]] already handled the SHAPE
    // (mandate or goal-milestone anchor); here we verify the referenced entity actually exists.
    const parent = (input.parent || "").trim();
    const goalM = parent.match(/goals\/([a-z0-9-]+)(?:#([^\]\s)]+))?/i);
    const fnM = parent.match(/functions\/([a-z0-9-]+)(?:#([a-z0-9-]+))?/i);
    if (goalM) {
      const [, gslug, msAnchor] = goalM;
      const knownMs = ctx.knownGoalMilestones.get(gslug.toLowerCase());
      if (!knownMs) {
        problems.push(`Parent goal \`${gslug}\` does not resolve to a \`public.goals\` row`);
      } else if (msAnchor) {
        // Milestone anchor named — must resolve.
        if (!knownMs.has(msAnchor.toLowerCase())) {
          problems.push(
            `Parent milestone \`[[../goals/${gslug}#${msAnchor}]]\` does not resolve to a goal_milestones row`,
          );
        }
      }
    } else if (fnM) {
      const [, fnSlug, mandateAnchor] = fnM;
      if (!ctx.knownFunctionSlugs.has(fnSlug.toLowerCase())) {
        problems.push(`Parent function \`${fnSlug}\` does not resolve to a \`docs/brain/functions/\` page`);
      } else if (mandateAnchor) {
        const key = `${fnSlug.toLowerCase()}#${mandateAnchor.toLowerCase()}`;
        if (!ctx.knownMandateRefs.has(key)) {
          problems.push(
            `Parent mandate \`[[../functions/${fnSlug}#${mandateAnchor}]]\` does not resolve to a mandate on that function`,
          );
        }
      }
    }
    // Free-text / other shapes are the caller's responsibility (`assertValidParent` throws
    // `InvalidParentError` before we get here on the fully-untyped bad-shape path).
  }

  // 5. Blocked-by resolves + acyclic.
  const blockedBy = (input.blocked_by ?? []).map((s) => s.trim()).filter(Boolean);
  for (const b of blockedBy) {
    if (!ctx.knownSpecSlugs.has(b)) {
      problems.push(`Blocked-by \`[[${b}]]\` does not resolve to a spec`);
    }
  }
  if (blockedBy.length) {
    // Build a graph that includes THIS spec's proposed edges, then walk from each blocker toward the
    // roots. If we ever reach this spec's own slug we've found a cycle that includes it.
    const graph = new Map<string, string[]>(ctx.blockedByGraph);
    graph.set(input.slug, blockedBy);
    if (hasCycleThroughRoot(input.slug, graph)) {
      problems.push(
        `Blocked-by list forms a cycle including \`${input.slug}\` — a spec cannot block itself transitively`,
      );
    }
  }

  // 6. `customer_id`-referenced table without a companion data-tool plan (CLAUDE.md hard rule —
  // `sonnet-orchestrator-v2.ts` wiring). Conservative match: only fires when a phase body carries BOTH
  // a create-table / add-column DDL AND a `customer_id` mention AND the spec text has no
  // `sonnet-orchestrator-v2` companion mention anywhere. Prevents false positives on incidental
  // `customer_id` lookups.
  const specText = [
    ...input.phases.map((p) => p.body ?? ""),
    ...input.phases.map((p) => p.verification ?? ""),
  ].join("\n\n");
  const hasSonnetToolMention = /sonnet-orchestrator-v2/i.test(specText);
  // `[\s\S]{0,400}` (not `[^\n]`) so a CREATE TABLE that spans multiple lines still matches its own
  // `customer_id` column below the header. Kept tight (≤400 chars) so the match stays within a single
  // DDL block, not across a whole phase body.
  const CUSTOMER_ID_DDL_RE = /\b(create\s+table|alter\s+table|add\s+column)\b[\s\S]{0,400}\bcustomer_id\b/i;
  for (const p of input.phases) {
    const body = p.body || "";
    if (CUSTOMER_ID_DDL_RE.test(body) && !hasSonnetToolMention) {
      problems.push(
        `Phase ${p.position} adds a \`customer_id\`-referenced table with no data-tool plan ` +
          `(CLAUDE.md hard rule — wire a Sonnet data tool in \`sonnet-orchestrator-v2.ts\` in the same PR)`,
      );
      // One flag per spec is enough — the fix is a companion plan, not per-phase.
      break;
    }
  }

  return problems;
}

/**
 * DFS from `root`'s outbound edges — return true iff we ever loop back to `root`. Uses a `visited` set to
 * bound work; a cycle that doesn't include `root` doesn't trip this (we only care about cycles that
 * transitively pull this spec in on itself, since that's the case the checklist bans).
 */
function hasCycleThroughRoot(root: string, graph: Map<string, string[]>): boolean {
  const startEdges = graph.get(root) ?? [];
  const visited = new Set<string>();
  const stack: string[] = [...startEdges];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === root) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const outs = graph.get(cur) ?? [];
    for (const o of outs) stack.push(o);
  }
  return false;
}

/**
 * Read the `docs/brain/functions/*.md` directory and return the set of bare slugs — the same set the
 * Owner check + the untyped-prose parent-function check compare against. A missing directory returns
 * the empty set (fail SAFE: an empty set → the Owner check reports "does not resolve", which is the
 * correct verdict when the brain is missing).
 */
async function collectFunctionSlugs(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const entries = await fs.readdir(FUNCTIONS_DIR);
    for (const e of entries) {
      if (!e.endsWith(".md")) continue;
      out.add(e.replace(/\.md$/, "").toLowerCase());
    }
  } catch {
    /* directory missing — fall through with the empty set */
  }
  return out;
}

/**
 * For each function slug on disk, resolve its `## Mandates` section (via [[function-mandates]]) and add
 * `{fn}#{mandate-slug}` (lowercase) to the set. This is the DB-side resolver Vale's coaching cites —
 * a `parent_kind='mandate'` `parent_ref='{fn}#{key}'` must appear here to resolve.
 */
async function collectMandateRefs(functionSlugs: Iterable<string>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const fn of functionSlugs) {
    try {
      const mandates = await resolveFunctionMandates(fn);
      for (const m of mandates) out.add(`${fn}#${m.slug.toLowerCase()}`);
    } catch {
      /* best-effort per-function — a parse blip on one doc shouldn't taint the set */
    }
  }
  return out;
}

/**
 * Materialize the context: function slugs on disk, every spec in the workspace (for blocked-by
 * resolution + cycle detection), every goal + milestone (for parent resolution), and every mandate key
 * (for typed-parent resolution). One call per author — the cost is bounded (dir scan + two SDK reads +
 * a per-function mandate parse) and the chokepoint runs at author frequency, not per-request.
 */
export async function buildSpecReviewGateContext(workspaceId: string): Promise<SpecReviewGateContext> {
  const [functionSlugs, specs, goals] = await Promise.all([
    collectFunctionSlugs(),
    // spec-read-egress-scope-and-cursor: `blocked_by` may legitimately reference a FOLDED spec, so
    // narrowing to active would make a valid reference look unknown and reject a good spec at author
    // time. Stays folded-inclusive, stated explicitly.
    getAllSpecs(workspaceId),
    listGoals(workspaceId),
  ]);
  const knownSpecSlugs = new Set(specs.map((s: SpecRow) => s.slug));
  const blockedByGraph = new Map<string, string[]>();
  for (const s of specs) blockedByGraph.set(s.slug, (s.blocked_by ?? []).map((b) => b.trim()).filter(Boolean));
  const knownMilestoneIds = new Set<string>();
  const knownGoalMilestones = new Map<string, Set<string>>();
  for (const g of goals as GoalRow[]) {
    const anchors = new Set<string>();
    for (const m of g.milestones ?? []) {
      knownMilestoneIds.add(m.id);
      anchors.add(kebabize(m.title));
      // Also accept `M{position}` anchor shape ("[[../goals/x#M4]]"), which is the shape the seeded
      // planner emits.
      anchors.add(`m${m.position}`.toLowerCase());
    }
    knownGoalMilestones.set(g.slug.toLowerCase(), anchors);
  }
  const knownMandateRefs = await collectMandateRefs(functionSlugs);
  return {
    knownFunctionSlugs: functionSlugs,
    knownSpecSlugs,
    blockedByGraph,
    knownMandateRefs,
    knownMilestoneIds,
    knownGoalMilestones,
  };
}

/**
 * Fail-loud author-time gate. Materialize the context, run the pure predicate, and throw
 * `SpecReviewGateError` on any problem. Callers in [[author-spec]] run this AFTER the existing shape
 * gates (`assertEveryPhaseHasVerification` / `assertEveryNodeHasIntent` / `assertEveryPhaseHasBody` /
 * `assertValidParent`) and BEFORE `upsertSpec` — so a well-formed spec proceeds to the DB write and a
 * malformed one is rejected at the same rail as the other authoring gates.
 */
export async function assertSpecReviewGate(
  workspaceId: string,
  input: SpecReviewGateInput,
): Promise<void> {
  const ctx = await buildSpecReviewGateContext(workspaceId);
  const problems = computeSpecReviewProblems(input, ctx);
  if (problems.length) throw new SpecReviewGateError(input.slug, problems);
}
