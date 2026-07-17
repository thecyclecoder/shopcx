/**
 * Canonical node registry (control-tower-canonical-node-registry P1) — ONE org tree fused from
 * the three sources of truth that used to disagree:
 *
 *   1. `MONITORED_LOOPS` in [[./registry]] — the box worker, every Inngest cron, every reactive
 *      Inngest fn, every inline AI agent, and every agent-kind box lane. Each entry already
 *      declares its `owner` OwnerFunction + (optionally) a `personaKind` mascot key.
 *   2. `PERSONAS` in [[../agents/personas]] — the directors keyed by function slug (Ada, Max,
 *      Iris, June, Theo — and the CEO seat) + every worker persona keyed by agent-kind. The
 *      `KIND_PERSONA_ALIAS` map alsotranslates a job-kind slug to the persona key when they
 *      differ (e.g. `deploy-review` → `deploy-guardian`).
 *   3. The `agent_jobs.kind` universe emitted by `scripts/builder-worker.ts` `dispatchJob` —
 *      every lane the box drains, including a handful that live OUTSIDE MONITORED_LOOPS (a
 *      director's own sweep pass — `agent-grade` / `director-grade` / `platform-director` — or
 *      a proposal kind — `db_health` / `coverage-register` / `proposed-goal` — that raises an
 *      agent_jobs row but isn't itself a monitored loop).
 *
 * A node is one of {department, director, agent, tool, cron, reactive, inline-agent}. Every
 * node carries its OWNER OwnerFunction + a PARENT nodeId chaining it up to the department
 * seat. The M4 CEO glance walks this tree department → director → agent → tool.
 *
 * `resolveNodeOwner(nodeId)` returns the OwnerFunction and NEVER falls through to the
 * `ORPHAN_OWNER = 'platform'` default from [[../agents/org-chart]] — that fallthrough is
 * preserved as an AUDIT HOOK Phase 2 consumes (`orphan_seen` counter + `console.warn`).
 * Here, a lookup miss returns `null` — the caller decides how to route it. The test suite
 * asserts every MONITORED_LOOPS id + every builder-worker kind resolves to a non-null owner
 * WITHOUT hitting the orphan fallthrough (that's the invariant the M4 glance depends on).
 *
 * Cross-references:
 * - [[../agents/approval-inbox]] `KIND_TO_FUNCTION_SHIM` — the compact backstop shim Phase 2
 *   leaves in place for the approval-only kinds that aren't first-class Nodes yet (retired one
 *   spec at a time). Any KIND_OWNER_FALLBACK entry named below MUST match the shim's owner.
 * - [[../agents/org-chart]] `ORPHAN_OWNER` + `resolveNodeOwnerOrOrphanDefault` — the audit
 *   fallthrough Phase 2 rewires through this registry; a miss records an `orphan_seen`
 *   sighting the orphan-node-self-audit reads via `getOrphanSightings()` below.
 * - [[./registry]] `OWNER_FUNCTIONS` + `MonitoredLoop` — the source of truth for the 5
 *   department seats + every monitored loop's declared owner.
 */
import {
  MONITORED_LOOPS,
  OWNER_FUNCTIONS,
  WORKER_BOX_ID,
  type OwnerFunction,
  type MonitoredLoop,
  type LoopKind,
} from "@/lib/control-tower/registry";
import { PERSONAS, type MascotId } from "@/lib/agents/personas";

/** Every distinct node kind in the canonical org tree. */
export type NodeKind = "department" | "director" | "agent" | "tool" | "cron" | "reactive" | "inline-agent";

/** One rung of the canonical org tree (control-tower-canonical-node-registry P1). */
export interface OrgNode {
  /** Stable id — reuses the MONITORED_LOOPS `id` for a monitored loop, the agent-kind slug for
   * a box lane not in MONITORED_LOOPS, `dept:<function>` for a department, `director:<function>`
   * for a director. */
  id: string;
  kind: NodeKind;
  /** Nodeid of the parent seat, or null for a root department. */
  parent: string | null;
  /** The org-chart function that OWNS this node — [[../agents/org-chart]] `ORPHAN_OWNER`
   * is deliberately NOT emitted here (see the audit hook Phase 2 wires in). */
  owner: OwnerFunction;
  /** `MascotId` of the persona that renders this node (defaults to `'default'` for a worker
   * whose persona entry uses the neutral fallback). The `MascotId` type is intentionally
   * narrow — every persona entry in `PERSONAS` declares an explicit `mascotId`, so we pull
   * that value directly. */
  persona?: MascotId;
  /** Short label for the CEO glance card. */
  label: string;
}

/**
 * Every `agent_jobs.kind` literal the box worker's `dispatchJob` handles
 * (`scripts/builder-worker.ts`). Kept as a `const` tuple so the P1 test suite can iterate
 * it and assert every kind resolves to a Node. The `_check-node-registry-drift.ts` script
 * (Phase 3) fails if this list diverges from the live worker's dispatch.
 */
export const BUILDER_WORKER_KINDS = [
  "plan",
  "fold",
  "goal-fold",
  "product-seed",
  "spec-chat",
  "ticket-improve",
  "ticket-handle",
  "triage-escalations",
  "spec-test",
  "migration-fix",
  "deploy-review",
  "mario",
  "cs-director-call",
  "playbook-compile",
  "ticket-analyze",
  "prompt-review",
  "dev-ask",
  "god-mode",
  "director-coach",
  "pr-resolve",
  "repair",
  "regression",
  "security-review",
  "agent-grade",
  "director-grade",
  "campaign-grade",
  "gap-grade",
  "research",
  "dr-content",
  "agent-coach",
  "storefront-optimizer",
  "db_health",
  "coverage-register",
  "platform-director",
  "director-bounce-back",
  "growth-director",
  "proposed-goal",
  "proposed-model-tier",
  "audit-spec-shipped-state",
  "ceo-authorized-out-of-leash",
  "media-buyer",
  "ad-creative",
  "ad-creative-copy-author",
  "ad-creative-copy-qc",
  "media-buyer-grade",
  "sensor-trust-probe",
  "calibrate-media-buyer-policy",
  "ads-supervisor",
  "build",
] as const;

export type BuilderWorkerKind = (typeof BUILDER_WORKER_KINDS)[number];

/**
 * Owner-function fallback for a builder-worker kind NOT carried in MONITORED_LOOPS as an
 * `agent-kind` or reactive-with-agentKind entry. These are the director's own sweep passes,
 * standing crons the director owns, and the proposal kinds `db_health` / `coverage-register`
 * that raise agent_jobs but run as platform crons. Every entry here is authoritative — the
 * approval-inbox shim only carries the 2 leftover approval-only kinds that don't yet have
 * first-class Nodes; the Phase 3 drift check fails if the two disagree.
 *
 * The five OwnerFunction extensions (`cfo` / `logistics` / `ceo`) are honored — the CEO
 * carries her own agent lane (Eve — god-mode), and the audit-only kinds route to Platform.
 */
const KIND_OWNER_FALLBACK: Record<string, OwnerFunction> = {
  // ── Director sweep passes (each director grades / coaches the layer below itself) ──
  "agent-grade": "platform", // Ada grades the platform worker fleet
  "agent-coach": "platform", // Ada coaches the platform worker fleet
  "director-grade": "ceo", // the CEO grades her directors
  "campaign-grade": "growth", // Cleo/Max grade storefront campaigns
  "gap-grade": "growth", // Max grades acquisition gap recommendations
  // ── Director standing passes (each director's own cron/coaching lane) ──
  "platform-director": "platform", // Ada's daily standing pass
  "director-coach": "platform", // Ada authors coach threads for her workers
  "director-bounce-back": "platform", // Ada's re-open backstop for stalled goals
  "growth-director": "growth", // Max's standing pass
  // ── Proposal kinds (raise agent_jobs but aren't monitored loops themselves) ──
  "db_health": "platform", // Devi proposes indexes / query fixes under Ada
  "coverage-register": "platform", // Cole proposes MONITORED_LOOPS registry entries under Ada
  "proposed-goal": "ceo", // a director may propose a goal but never greenlight — CEO decides
  "proposed-model-tier": "platform", // Ada proposes model tier changes (may re-route by target_kind)
  "audit-spec-shipped-state": "platform", // Ada's audit sweep
  "ceo-authorized-out-of-leash": "ceo", // out-of-leash execution — the CEO owns it
  "sensor-trust-probe": "growth", // Bianca / Max sensor calibration
  "calibrate-media-buyer-policy": "growth", // Bianca policy calibration under Max
  "goal-fold": "platform", // Fenn folds a completed goal
  // ── The CEO's own agent lane ──
  "god-mode": "ceo", // Eve, the CEO's executive assistant
  // ── Box lanes whose kind isn't a MONITORED_LOOPS `agent-kind` row (they run under a cron
  // or reactive loop, but the KIND itself is a distinct builder-worker dispatch). Each maps
  // to the same owner its supervising director carries. ──
  "cs-director-call": "cs", // June's own review box session (reactive under her)
  "playbook-compile": "cs", // June-supervised full-history playbook mining
  "research": "growth", // Rhea's scout box session (crons carry `personaKind:'research'`)
  "media-buyer": "growth", // Bianca — daily creative test cadence under Max
  "ad-creative": "growth", // Dahlia — bin-stocking under Max
  "ad-creative-copy-author": "growth", // Dahlia — per-creative Max copy-author box session (DAHLIA_COPY_MODE=author gate, dahlia-copy-author-box-session)
  "ad-creative-copy-qc": "growth", // Max — per-creative INDEPENDENT copy-QC box session (DAHLIA_QC_COPY_MODE=box gate, dahlia-max-independent-copy-qc-box-session)
  "media-buyer-grade": "growth", // Bianca / Max grading pass
  "ads-supervisor": "growth", // ads-supervisor-3h-agent — 3h supervisory pass over Bianca + Dahlia (owner: Max)
};

/**
 * Retired agent-kinds — the box no longer DISPATCHES these (they're absent from
 * BUILDER_WORKER_KINDS + `dispatchJob`), but historical `agent_jobs` rows still carry the kind,
 * so `select distinct kind from public.agent_jobs` returns it and the canonical-registry live-kind
 * coverage check (this spec's Phase 1 verification) requires the registry to resolve it to an
 * owner. A retired kind gets a `retired` Node (owner below) via buildNodeRegistry step 7, but is
 * deliberately NOT in BUILDER_WORKER_KINDS, so the dispatch↔kinds drift check never expects a live
 * `dispatchJob` lane for it. Add a kind here the moment it leaves BUILDER_WORKER_KINDS + dispatch.
 */
export const RETIRED_KIND_OWNER: Record<string, OwnerFunction> = {
  "spec-review": "platform", // Vale — graduated to the deterministic `assertSpecReviewGate` authoring gate (retire-vale-spec-review-becomes-deterministic-authoring-gate)
};

/** The MascotId of a director keyed by function slug (from PERSONAS). */
function directorMascot(fn: OwnerFunction): MascotId {
  const persona = PERSONAS[fn];
  if (persona) return persona.mascotId;
  return "default";
}

/** Map a MonitoredLoop.kind to the canonical NodeKind. */
function loopKindToNodeKind(kind: LoopKind): NodeKind {
  switch (kind) {
    case "worker":
      return "tool";
    case "cron":
      return "cron";
    case "reactive":
      return "reactive";
    case "agent-kind":
      return "agent";
    case "inline-agent":
      return "inline-agent";
  }
}

/** Resolve the persona MascotId for a MONITORED_LOOPS entry from its personaKind / agentKind. */
function personaForLoop(loop: MonitoredLoop): MascotId | undefined {
  const key = loop.personaKind ?? loop.agentKind;
  if (!key) return undefined;
  const persona = PERSONAS[key];
  return persona ? persona.mascotId : undefined;
}

/** Resolve the persona MascotId for a builder-worker kind (falls back to `undefined`). */
function personaForKind(kind: string): MascotId | undefined {
  const persona = PERSONAS[kind];
  return persona ? persona.mascotId : undefined;
}

/** Compute the parent node id for a node whose owner is `fn`. Root departments have no parent;
 * every non-CEO owner nests under its director; the CEO owner nests directly under her own
 * department seat (`dept:ceo`), the founder-owned lane that isn't a rollup Health tile. */
function parentIdForOwner(fn: OwnerFunction): string {
  return `director:${fn}`;
}

/** Build the canonical node registry (one-shot; the result is frozen). */
function buildNodeRegistry(): OrgNode[] {
  const nodes: OrgNode[] = [];
  const seen = new Set<string>();

  const addNode = (node: OrgNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
  };

  // ── 1. Department seats — the 5 OWNER_FUNCTIONS ([[./registry]]) ─────────────
  for (const dept of OWNER_FUNCTIONS) {
    addNode({
      id: `dept:${dept.id}`,
      kind: "department",
      parent: null,
      owner: dept.id,
      persona: directorMascot(dept.id),
      label: dept.label,
    });
  }

  // ── 2. CEO seat — the founder-owned lane that isn't a rollup Health tile ────
  // (registry.ts:50-53: OwnerFunction was widened to include `ceo` for Eve's god-mode-cockpit
  // reactive lane; the CEO isn't a department that gets a rollup tile, but she needs a seat so
  // her nodes have a home under this tree.)
  addNode({
    id: "dept:ceo",
    kind: "department",
    parent: null,
    owner: "ceo",
    persona: directorMascot("ceo"),
    label: "CEO",
  });

  // ── 3. Extension seats for the two owner functions declared in personas but not yet in
  // OWNER_FUNCTIONS (cfo / logistics — Grace / Marco). Kept so a future MONITORED_LOOPS row
  // that carries `owner:'cfo' | 'logistics'` resolves cleanly instead of dropping to null. ──
  for (const fn of ["cfo", "logistics"] as const) {
    addNode({
      id: `dept:${fn}`,
      kind: "department",
      parent: null,
      owner: fn,
      persona: directorMascot(fn),
      label: PERSONAS[fn]?.role ?? fn,
    });
  }

  // ── 4. Directors — one per department seat (persona keyed by function slug) ──
  for (const fn of ["platform", "growth", "retention", "cs", "cmo", "cfo", "logistics", "ceo"] as const) {
    addNode({
      id: `director:${fn}`,
      kind: "director",
      parent: `dept:${fn}`,
      owner: fn,
      persona: directorMascot(fn),
      label: PERSONAS[fn]?.role ?? fn,
    });
  }

  // ── 5. Each MONITORED_LOOPS entry — box worker, crons, reactive fns, agent-kind lanes,
  // inline agents — reusing its declared owner + optional personaKind. ─────────
  for (const loop of MONITORED_LOOPS) {
    addNode({
      id: loop.id,
      kind: loopKindToNodeKind(loop.kind),
      parent: parentIdForOwner(loop.owner),
      owner: loop.owner,
      persona: personaForLoop(loop),
      label: loop.label,
    });
  }

  // ── 6. Every builder-worker kind that isn't already a MONITORED_LOOPS agent-kind /
  // reactive-with-agentKind entry (director sweeps, standing passes, proposal kinds). The
  // owner comes from `KIND_OWNER_FALLBACK`. ────────────────────────────────────
  const monitoredAgentKinds = new Set<string>();
  for (const loop of MONITORED_LOOPS) {
    if (loop.agentKind) monitoredAgentKinds.add(loop.agentKind);
  }
  for (const kind of BUILDER_WORKER_KINDS) {
    if (monitoredAgentKinds.has(kind)) continue; // already registered as its MONITORED_LOOPS row
    const owner = KIND_OWNER_FALLBACK[kind];
    if (!owner) continue; // orphan — surfaced by the Phase 3 drift check
    addNode({
      id: `agent-kind:${kind}`,
      kind: "agent",
      parent: parentIdForOwner(owner),
      owner,
      persona: personaForKind(kind),
      label: PERSONAS[kind]?.name ?? kind,
    });
  }

  // ── 7. Retired kinds (RETIRED_KIND_OWNER) — no longer dispatched, but historical `agent_jobs`
  // rows keep the kind in `select distinct kind`, so the registry must still resolve it. Node id
  // is `agent-kind:<kind>` (same shape resolveNodeOwner's slug convenience looks up). ──────────
  for (const [kind, owner] of Object.entries(RETIRED_KIND_OWNER)) {
    addNode({
      id: `agent-kind:${kind}`,
      kind: "agent",
      parent: parentIdForOwner(owner),
      owner,
      persona: personaForKind(kind),
      label: `${PERSONAS[kind]?.name ?? kind} (retired)`,
    });
  }

  return nodes;
}

/**
 * The canonical node registry — frozen after construction (a re-import returns the same
 * object graph, and downstream code cannot mutate a Node in place).
 */
export const NODES: readonly OrgNode[] = Object.freeze(buildNodeRegistry());

const NODES_BY_ID: ReadonlyMap<string, OrgNode> = (() => {
  const m = new Map<string, OrgNode>();
  for (const n of NODES) m.set(n.id, n);
  return m;
})();

/**
 * agentKind → node — a MONITORED_LOOPS row whose `id` is `<slug>-agent` (Reva's
 * `deploy-review-agent` reactive, Mario's `mario-agent` reactive) is looked up by its
 * `agentKind` slug from downstream callers that see `job.kind = 'deploy-review'`. This
 * secondary index lets `resolveNodeOwner(slug)` hit those rows without renaming their ids.
 */
const NODES_BY_AGENT_KIND: ReadonlyMap<string, OrgNode> = (() => {
  const m = new Map<string, OrgNode>();
  for (const loop of MONITORED_LOOPS) {
    if (!loop.agentKind) continue;
    const node = NODES_BY_ID.get(loop.id);
    if (node) m.set(loop.agentKind, node);
  }
  return m;
})();

/** Return the Node for `nodeId`, or `null` if it isn't registered. */
export function getNode(nodeId: string): OrgNode | null {
  return NODES_BY_ID.get(nodeId) ?? null;
}

/**
 * Resolve the OWNER OwnerFunction of a node. Returns `null` when the node is genuinely
 * un-placed — Phase 2 rewires the `ORPHAN_OWNER='platform'` fallthrough in
 * [[../agents/org-chart]] through this registry, and a null answer here becomes an audited
 * `orphan_seen` sighting rather than a silent Platform default.
 *
 * The caller may pass either a canonical node id (e.g. `deploy-review-agent`, `agent:build`)
 * OR a raw agent-kind slug (e.g. `build`, `security-review`) — both resolve, so callers
 * that already look up by kind (approval-inbox / agent-grader / model-tier-proposals) don't
 * need to rewrite their call sites in Phase 2.
 */
export function resolveNodeOwner(nodeId: string): OwnerFunction | null {
  // Direct hit — the caller passed a canonical node id.
  const direct = NODES_BY_ID.get(nodeId);
  if (direct) return direct.owner;
  // Agent-kind slug convenience: `<kind>` maps to `agent-kind:<kind>` (source 6) or the
  // MONITORED_LOOPS row keyed as `agent:<kind>` (source 5). Try each in turn.
  const asAgentKind = NODES_BY_ID.get(`agent-kind:${nodeId}`);
  if (asAgentKind) return asAgentKind.owner;
  const asMonitored = NODES_BY_ID.get(`agent:${nodeId}`);
  if (asMonitored) return asMonitored.owner;
  // MONITORED_LOOPS reactive/cron whose id ISN'T `agent:<kind>` but whose `agentKind` field
  // matches — e.g. Reva's `deploy-review-agent` reactive, Mario's `mario-agent` reactive.
  const byAgentKind = NODES_BY_AGENT_KIND.get(nodeId);
  if (byAgentKind) return byAgentKind.owner;
  return null;
}

/**
 * Orphan-sightings counter (control-tower-canonical-node-registry P2 — audit hook the
 * orphan-node-self-audit Phase 1 will consume via `auditOrphanNodes()`). Every time the
 * legacy `ORPHAN_OWNER='platform'` fallthrough in [[../agents/org-chart]] would silently
 * default an unknown node to Platform, we route through `resolveNodeOwnerOrOrphanDefault`
 * INSTEAD, which:
 *
 *   1. calls `resolveNodeOwner(nodeId)` — if the registry knows the node, return the real
 *      owner (no orphan sighting recorded);
 *   2. otherwise `console.warn` an "orphan node sighted" line so it also shows up in the
 *      Vercel error feed / local dev output;
 *   3. increment `orphanSightings.get(nodeId)` — a per-id counter the audit reads.
 *
 * The Phase 1 audit (spec: orphan-node-self-audit) will iterate this map, dedupe against
 * `MONITORED_LOOPS` / `BUILDER_WORKER_KINDS`, and open Approval Requests for the ones that
 * are genuinely orphaned (a real coverage gap) so Cole's registry gets them registered.
 */
const orphanSightings: Map<string, number> = new Map();

/**
 * Read a snapshot of the orphan-sightings counter. Returns a plain object keyed by the
 * unregistered nodeId with its sighting count as the value. The audit consumer resets
 * counts after processing via `resetOrphanSightings()`.
 */
export function getOrphanSightings(): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const [id, count] of orphanSightings) snap[id] = count;
  return snap;
}

/** Clear the orphan-sightings counter (used by the audit after it processes a batch, + by tests). */
export function resetOrphanSightings(): void {
  orphanSightings.clear();
}

/**
 * The Phase-2 replacement for `ORPHAN_OWNER='platform'` in [[../agents/org-chart]]:
 *
 *   • Every call routes through the canonical node registry FIRST — a registered node returns
 *     its declared owner (never routed as Platform by default).
 *   • A genuine miss records an `orphan_seen` sighting (console.warn + counter bump) so the
 *     `orphan-node-self-audit` Phase 1 sweep can surface it, and falls back to the historical
 *     `platform` default so caller behavior is preserved (the roster never breaks the dashboard).
 *
 * `context` is a short label naming the callsite (e.g. `"org-chart:orphan-union"`), embedded
 * in the warn line so a dev reading Vercel logs can trace where the sighting fired.
 */
export function resolveNodeOwnerOrOrphanDefault(nodeId: string, context: string): OwnerFunction {
  const known = resolveNodeOwner(nodeId);
  if (known) return known;
  console.warn(
    `[node-registry] orphan node sighted (id='${nodeId}', at='${context}') — no registered owner; defaulting to platform`,
  );
  orphanSightings.set(nodeId, (orphanSightings.get(nodeId) ?? 0) + 1);
  return "platform";
}

/** Return the parent Node for `nodeId`, walking one rung up (null at a root department or miss). */
export function getParent(nodeId: string): OrgNode | null {
  const node = NODES_BY_ID.get(nodeId);
  if (!node || !node.parent) return null;
  return NODES_BY_ID.get(node.parent) ?? null;
}

/** All direct children of `nodeId` — useful for the CEO-glance drilldown. */
export function getChildren(nodeId: string): OrgNode[] {
  return NODES.filter((n) => n.parent === nodeId);
}

/**
 * Sanity assertion — asserts every MONITORED_LOOPS id + every BUILDER_WORKER_KINDS entry
 * resolves to a non-null OwnerFunction. Called from the Phase 3 drift check + the P1 test
 * suite. Throws on the first miss so the failing id shows up in the test output.
 */
export function assertCoverage(): void {
  for (const loop of MONITORED_LOOPS) {
    if (!resolveNodeOwner(loop.id)) {
      throw new Error(`node-registry: MONITORED_LOOPS id '${loop.id}' does not resolve to a Node`);
    }
  }
  for (const kind of BUILDER_WORKER_KINDS) {
    if (!resolveNodeOwner(kind)) {
      throw new Error(`node-registry: builder-worker kind '${kind}' does not resolve to a Node`);
    }
  }
  // Sanity check on the box worker specifically — its id is `WORKER_BOX_ID` (a `worker`
  // MonitoredLoop that maps to a `tool` node under director:platform).
  if (resolveNodeOwner(WORKER_BOX_ID) !== "platform") {
    throw new Error(`node-registry: box worker '${WORKER_BOX_ID}' must resolve to owner='platform'`);
  }
}
