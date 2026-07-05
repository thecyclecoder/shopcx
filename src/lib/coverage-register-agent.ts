/**
 * coverage-register-agent — detect an unregistered cron loop in the Control Tower coverage
 * self-audit and PROPOSE the MONITORED_LOOPS entry that closes the gap (docs/brain/specs/
 * coverage-auto-register-agent.md, Phase 1). "the repair agent, but for coverage gaps."
 *
 * North star (supervisable autonomy): the coverage self-audit DETECTS the gap (a cron
 * `createFunction` served in code with no MONITORED_LOOPS tile + not on the exemption list). This is
 * the objective-owner loop above that proxy — it AUTHORS the inferred registry entry and SURFACES it
 * for one-tap owner Build. It NEVER silently edits registry.ts: adding a monitored loop sets an
 * alerting contract, so the owner confirms the owner-function + cadence/window — or marks the loop
 * intentionally-unmonitored (a registered exemption, so it stops re-surfacing). Both outcomes close
 * the amber gap permanently.
 *
 * Unlike the repair agent (which needs an LLM to diagnose a root cause), the fix here is fully
 * MECHANICAL: `id` is the fn id, `kind:'cron'`, `expectedCadence` + `livenessWindowMs` derive from the
 * cron schedule the audit already knows, and a proposed `owner` from the fn's id/domain. So the entry
 * is inferred deterministically at enqueue time and the proposal surfaces directly as needs_approval —
 * the box runner only materializes the chosen fix spec to main + queues its build on the owner's tap.
 *
 * Trigger: event-driven on the audit, NOT a blind cron. `enqueueCoverageRegisterJob` is called inline
 * in `runControlTowerMonitor` for each `selfAudit.unregistered` loop. Deduped: one open proposal per
 * loop id (mirror the repair-agent dedup).
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { OwnerFunction } from "@/lib/control-tower/registry";

type Admin = ReturnType<typeof createAdminClient>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** spec_slug prefix / dedup-key namespace for a coverage-register proposal job. */
export const COVERAGE_REGISTER_SLUG_PREFIX = "coverage-register:";
/** A fix authored within this window is "pending deploy" — don't re-propose the same gap (mirror
 *  REPAIR_RECENT_FIX_WINDOW_MS): bridges the build→merge→deploy gap before the entry actually lands. */
export const COVERAGE_REGISTER_RECENT_WINDOW_MS = 24 * HOUR;

/** Statuses that mean a coverage-register job for a loop id is still "live" (working or surfaced). */
const LIVE_COVERAGE_STATUSES = [
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
  "needs_attention",
];

/** The inferred MONITORED_LOOPS entry the agent proposes for an unregistered cron loop. */
export interface InferredLoopEntry {
  id: string;
  kind: "cron";
  owner: OwnerFunction;
  label: string;
  description: string;
  expectedCadence: string;
  livenessWindowMs: number;
  /** set for long-cadence (≥ daily) crons so they claim the registered_not_firing grace. */
  registeredAt?: string;
}

/**
 * Infer the cron's human cadence label + a cadence-derived liveness window (cadence + grace). Pure.
 * The window mirrors the registry's existing conventions: hourly→2h, daily→26h, every-N-min→~4N min.
 * The owner CONFIRMS this before merge, so a coarse-but-safe (generous) estimate is the right default.
 */
export function inferCadence(cronExpr: string): { label: string; windowMs: number } {
  const expr = (cronExpr || "").trim();
  const parts = expr.split(/\s+/);
  if (parts.length < 5) return { label: expr ? `cron (${expr})` : "cron", windowMs: 26 * HOUR };
  const [min, hour, dom, , dow] = parts;

  if (hour === "*") {
    if (min === "*") return { label: `every minute (${expr})`, windowMs: 15 * MIN };
    const stepMin = /^\*\/(\d+)$/.exec(min);
    if (stepMin) {
      const n = Math.max(1, Number(stepMin[1]));
      return { label: `every ${n} min (${expr})`, windowMs: Math.max(4 * n, 15) * MIN };
    }
    if (min.includes(",")) return { label: `multiple times hourly (${expr})`, windowMs: 90 * MIN };
    return { label: `hourly (${expr})`, windowMs: 2 * HOUR };
  }

  const stepHour = /^\*\/(\d+)$/.exec(hour);
  if (stepHour) {
    const n = Math.max(1, Number(stepHour[1]));
    return { label: `every ${n}h (${expr})`, windowMs: (n + 1) * HOUR };
  }

  if (dow !== "*") return { label: `weekly (${expr})`, windowMs: 8 * DAY };
  if (dom !== "*") return { label: `monthly (${expr})`, windowMs: 32 * DAY };
  // fixed minute + fixed hour, every day.
  return { label: `daily (${expr})`, windowMs: 26 * HOUR };
}

/**
 * Infer the owner-function from the loop id / domain (the owner CONFIRMS / overrides before merge):
 * storefront-/meta-/ads/capi → growth · ticket-/escalation/csat → cs · renewal/subscription/
 * dunning/loyalty/journey/return → retention · scorecard/campaign → cmo · else platform (the default).
 */
export function inferOwner(loopId: string): OwnerFunction {
  const id = (loopId || "").toLowerCase();
  if (/^storefront-|^meta-|capi|(^|-)ad(s)?(-|$)/.test(id)) return "growth";
  if (/^ticket-|escalation|csat|support/.test(id)) return "cs";
  if (/renewal|subscription|dunning|loyalty|journey|return/.test(id)) return "retention";
  if (/scorecard|campaign/.test(id)) return "cmo";
  return "platform";
}

/** Build the full inferred MONITORED_LOOPS entry for an unregistered cron loop. Pure + deterministic. */
export function inferLoopEntry(loopId: string, cadence: string, nowIso?: string): InferredLoopEntry {
  const { label, windowMs } = inferCadence(cadence);
  const entry: InferredLoopEntry = {
    id: loopId,
    kind: "cron",
    owner: inferOwner(loopId),
    label: loopId,
    description: `Auto-proposed monitored loop for the ${loopId} cron (${label}). Confirm the owner-function + cadence/window.`,
    expectedCadence: label,
    livenessWindowMs: windowMs,
  };
  // Long-cadence crons need registeredAt to claim the registered_not_firing newcron grace.
  if (windowMs >= 6 * HOUR) entry.registeredAt = nowIso || new Date().toISOString();
  return entry;
}

/** Render a liveness window in the registry's `N * UNIT` house style. */
function humanWindow(ms: number): string {
  if (ms % DAY === 0) return `${ms / DAY} * DAY`;
  if (ms % HOUR === 0) return `${ms / HOUR} * HOUR`;
  return `${Math.round(ms / MIN)} * MIN`;
}

/** Render the inferred entry as the exact TS snippet to paste into MONITORED_LOOPS. */
export function renderEntrySnippet(entry: InferredLoopEntry): string {
  const lines = [
    "  {",
    `    id: ${JSON.stringify(entry.id)},`,
    `    kind: "cron",`,
    `    owner: ${JSON.stringify(entry.owner)},`,
    `    label: ${JSON.stringify(entry.label)},`,
    `    description: ${JSON.stringify(entry.description)},`,
    `    expectedCadence: ${JSON.stringify(entry.expectedCadence)},`,
    `    livenessWindowMs: ${humanWindow(entry.livenessWindowMs)},`,
  ];
  if (entry.registeredAt) lines.push(`    registeredAt: ${JSON.stringify(entry.registeredAt)},`);
  lines.push("  },");
  return lines.join("\n");
}

/** Sanitize a loop id into a kebab spec slug fragment. */
function slugFragment(loopId: string): string {
  return loopId.replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 50);
}
export function registerSpecSlug(loopId: string): string {
  return `register-loop-${slugFragment(loopId)}`.slice(0, 60);
}
export function exemptSpecSlug(loopId: string): string {
  return `exempt-loop-${slugFragment(loopId)}`.slice(0, 60);
}

/** The single-phase fix spec that ADDS the inferred MONITORED_LOOPS entry. Built by the box on Build. */
export function buildRegisterSpecBody(entry: InferredLoopEntry): string {
  const slug = registerSpecSlug(entry.id);
  return `# Register monitored loop: ${entry.id} ⏳

**Owner:** [[../functions/${entry.owner}]] · **Parent:** [[../functions/platform]] — "Infra & DevOps / reliability" mandate (loop-coverage monitoring; auto-proposed by [[../libraries/coverage-register-agent]] from the [[control-tower-complete-coverage]] self-audit).

The coverage self-audit found a cron \`createFunction\` served in code (\`${entry.id}\`, ${entry.expectedCadence}) with **no \`MONITORED_LOOPS\` tile** — an unregistered loop. This spec adds the inferred registry entry so the loop becomes a real monitored tile. Confirm the inferred **owner-function** (\`${entry.owner}\`) + cadence/window before merging.

## Phase 1 — add the MONITORED_LOOPS entry ⏳
In \`src/lib/control-tower/registry.ts\`, add this entry to \`MONITORED_LOOPS\` (in the Inngest crons group):

\`\`\`ts
${renderEntrySnippet(entry)}
\`\`\`

No other change. After merge + deploy the amber "unregistered loop: ${entry.id}" gap clears and a \`${entry.id}\` cron tile appears.

## Verification
- On /dashboard/developer/control-tower, the Coverage self-audit no longer lists "Unregistered loop: ${entry.id}".
- A \`${entry.id}\` cron tile appears in the monitored loops grid (green once it has beaten, amber "awaiting first run" until then — never a false red).

<!-- coverage-register: ${slug} for loop ${entry.id} -->
`;
}

/** The single-phase fix spec that EXEMPTS the loop (intentionally-unmonitored). Built on the owner tap. */
export function buildExemptSpecBody(loopId: string, owner: OwnerFunction): string {
  const slug = exemptSpecSlug(loopId);
  return `# Exempt loop from coverage monitoring: ${loopId} ⏳

**Owner:** [[../functions/${owner}]] · **Parent:** [[../functions/platform]] — "Infra & DevOps / reliability" mandate (loop-coverage monitoring; auto-proposed by [[../libraries/coverage-register-agent]] from the [[control-tower-complete-coverage]] self-audit).

The owner marked \`${loopId}\` **intentionally-unmonitored** — a registered exemption so the coverage self-audit stops flagging it (silence is never the default; this is the owner-confirmed exception).

## Phase 1 — add the INTENTIONALLY_UNMONITORED_CRONS exemption ⏳
In \`src/lib/control-tower/registry.ts\`, add to \`INTENTIONALLY_UNMONITORED_CRONS\`:

\`\`\`ts
  ${JSON.stringify(loopId)}: "intentionally unmonitored — owner-confirmed via the coverage-register agent",
\`\`\`

No other change. After merge + deploy the audit no longer flags \`${loopId}\` as an unregistered loop.

## Verification
- On /dashboard/developer/control-tower, the Coverage self-audit no longer lists "Unregistered loop: ${loopId}".

<!-- coverage-register exemption: ${slug} for loop ${loopId} -->
`;
}

/**
 * Resolve the workspace a coverage-register proposal lands under — the build queue is effectively
 * single-tenant, so ride the latest agent_jobs row's workspace, falling back to the first workspace.
 */
async function resolveWorkspace(admin: Admin): Promise<string | null> {
  const { data: latestJob } = await admin
    .from("agent_jobs")
    .select("workspace_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromJob = (latestJob as { workspace_id?: string } | null)?.workspace_id;
  if (fromJob) return fromJob;
  const { data: ws } = await admin.from("workspaces").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
  return (ws as { id?: string } | null)?.id ?? null;
}

export interface EnqueueCoverageRegisterInput {
  /** the unregistered loop's inngest fn id. */
  loopId: string;
  /** the cron expression(s) the audit reported for it. */
  cadence: string;
}

/**
 * Enqueue a coverage-register PROPOSAL for an unregistered cron loop. Best-effort + idempotent:
 *   - no-op if a coverage-register job for this loop id is already live (one open proposal per loop), OR
 *   - no-op if a non-dismissed one COMPLETED within the recent window (its fix is pending deploy — the
 *     audit still sees the gap until the entry/exemption merges + deploys; don't re-propose meanwhile).
 * The inferred entry + both fix-spec bodies (register + exempt) are baked into `instructions`; the job
 * surfaces directly as `needs_approval` with a single `coverage_register` pending action. NEVER throws —
 * it rides the monitor's act loop. Returns whether a new proposal was enqueued.
 */
export async function enqueueCoverageRegisterJob(
  admin: Admin,
  input: EnqueueCoverageRegisterInput,
): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    const signature = `${COVERAGE_REGISTER_SLUG_PREFIX}${input.loopId}`;
    const { data: recent } = await admin
      .from("agent_jobs")
      .select("id, status, error, created_at")
      .eq("kind", "coverage-register")
      .eq("spec_slug", signature)
      .order("created_at", { ascending: false })
      .limit(5);
    const rows = (recent ?? []) as Array<{ id: string; status: string; error: string | null; created_at: string }>;
    if (rows.some((r) => LIVE_COVERAGE_STATUSES.includes(r.status))) {
      return { enqueued: false, reason: "live coverage-register proposal exists for this loop" };
    }
    const windowStart = Date.now() - COVERAGE_REGISTER_RECENT_WINDOW_MS;
    const recentlyBuilt = rows.some(
      (r) => r.status === "completed" && (r.error ?? "") !== "dismissed by owner" && Date.parse(r.created_at) >= windowStart,
    );
    if (recentlyBuilt) return { enqueued: false, reason: "fix recently built for this loop — deploying" };

    const workspaceId = await resolveWorkspace(admin);
    if (!workspaceId) return { enqueued: false, reason: "no workspace to attach the proposal to" };

    const entry = inferLoopEntry(input.loopId, input.cadence);
    const regSlug = registerSpecSlug(input.loopId);
    const exSlug = exemptSpecSlug(input.loopId);
    const actionId = `cov-${slugFragment(input.loopId)}`.slice(0, 80);

    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: signature,
      kind: "coverage-register",
      status: "needs_approval",
      log_tail: `Unregistered loop ${input.loopId} (${entry.expectedCadence}) → proposed registry entry (owner ${entry.owner}, window ${humanWindow(entry.livenessWindowMs)})`.slice(-2000),
      instructions: JSON.stringify({
        signature,
        loop_id: input.loopId,
        cadence: input.cadence,
        entry,
        register_spec_slug: regSlug,
        register_spec_body: buildRegisterSpecBody(entry),
        exempt_spec_slug: exSlug,
        exempt_spec_body: buildExemptSpecBody(input.loopId, entry.owner),
      }),
      pending_actions: [
        { id: actionId, type: "coverage_register", status: "pending", spec_slug: regSlug, spec_title: `Register monitored loop: ${input.loopId}` },
      ],
    });
    if (error) {
      console.warn(`[coverage-register] enqueue failed for ${input.loopId}:`, error.message);
      return { enqueued: false, reason: error.message };
    }
    return { enqueued: true };
  } catch (err) {
    console.warn("[coverage-register] enqueueCoverageRegisterJob threw:", err instanceof Error ? err.message : err);
    return { enqueued: false, reason: "threw" };
  }
}

// ── Dashboard surface (read-only) ────────────────────────────────────────────

export interface CoverageRegisterItem {
  jobId: string;
  /** the unregistered loop's fn id. */
  loopId: string;
  /** the cron schedule the audit reported. */
  cadence: string;
  /** the inferred owner-function. */
  proposedOwner: OwnerFunction;
  /** the inferred cadence label. */
  proposedCadence: string;
  /** the fix spec slug authored on Build. */
  registerSlug: string;
  createdAt: string;
}

/**
 * READ-ONLY: the open coverage-register proposals awaiting the owner on the Control Tower. A proposal
 * surfaces while `needs_approval`; Build (register) / Intentionally-unmonitored (exempt) / Dismiss
 * complete it. Drives the Control Tower "Coverage registration" feed.
 */
export async function getOpenCoverageRegistrations(admin: Admin, workspaceId: string): Promise<CoverageRegisterItem[]> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, status, instructions, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "coverage-register")
    .eq("status", "needs_approval")
    .order("created_at", { ascending: false })
    .limit(50);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    let loopId = String(row.spec_slug || "").replace(COVERAGE_REGISTER_SLUG_PREFIX, "");
    let cadence = "";
    let proposedOwner: OwnerFunction = "platform";
    let proposedCadence = "";
    let registerSlug = "";
    try {
      const instr = row.instructions ? JSON.parse(String(row.instructions)) : {};
      if (instr.loop_id) loopId = String(instr.loop_id);
      if (instr.cadence) cadence = String(instr.cadence);
      if (instr.register_spec_slug) registerSlug = String(instr.register_spec_slug);
      const entry = (instr.entry || {}) as Partial<InferredLoopEntry>;
      if (entry.owner) proposedOwner = entry.owner as OwnerFunction;
      if (entry.expectedCadence) proposedCadence = String(entry.expectedCadence);
    } catch {
      /* instructions not JSON — fall back to the slug */
    }
    return {
      jobId: String(row.id),
      loopId,
      cadence,
      proposedOwner,
      proposedCadence,
      registerSlug,
      createdAt: String(row.created_at || ""),
    };
  });
}
