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
import type { StructuredSpecInput } from "@/lib/author-spec";

type Admin = ReturnType<typeof createAdminClient>;

/** File the coverage-register grep check asserts the loop id landed in — MONITORED_LOOPS lives here
 *  (for the register spec) and INTENTIONALLY_UNMONITORED_CRONS lives here too (for the exempt spec),
 *  so the same grep pattern (the loop id string) resolves the coverage gap in either case. */
export const COVERAGE_REGISTRY_FILE = "src/lib/control-tower/registry.ts";

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
 * storefront-/meta-/ads/capi/research/creative/acquisition/lander/scout/prospect/brand → growth ·
 * ticket-/escalation/csat/support → cs · renewal/subscription/dunning/loyalty/journey/return →
 * retention · scorecard/crisis/blog/copy/creative-brief/social/email/klaviyo → cmo · else null
 * (unknown — the caller must NOT ship a fake `platform` guess with the boilerplate placeholder).
 *
 * Agent-mandate-hardening coaching bake-in (2026-07): the previous default of `owner: 'platform'` +
 * "Confirm the owner-function" description shipped as *ready to merge* on acquisition-research-* /
 * creative-finder-* crons (they don't match the old narrow regex → they fell to `platform`), which
 * was WRONG for those growth-owned crons. The mandate: catch every known growth/cs/retention/cmo
 * shape here, and when we still can't classify, return `null` so `inferLoopEntry` marks the entry
 * low-confidence (explicit "REQUIRES OWNER CONFIRMATION" in the description + `platform` as a
 * placeholder to keep the type honest), rather than silently pretending we knew.
 */
export function inferOwner(loopId: string): OwnerFunction | null {
  const id = (loopId || "").toLowerCase();
  if (/^storefront-|^meta-|capi|(^|-)ad(s)?(-|$)|research|creative|acquisition|lander|landing|scout|prospect|(^|-)brand(-|$)|amazon|demograph/.test(id)) return "growth";
  if (/^ticket-|escalation|csat|support|inbox/.test(id)) return "cs";
  if (/renewal|subscription|dunning|loyalty|journey|return|refund|churn/.test(id)) return "retention";
  if (/scorecard|campaign|crisis|blog|copy|creative-brief|social|email|klaviyo/.test(id)) return "cmo";
  // platform-owned infra shapes we DO recognize (so we don't slip past into low-confidence): control-
  // tower, brain, spec, build, deploy, security, control-plane, monitor, watchdog, backup, migration.
  if (/control-tower|brain|(^|-)spec(-|$)|build|deploy|security|monitor|watchdog|backup|migration|health|platform|director|worker|inngest|control-plane|sync/.test(id)) return "platform";
  return null;
}

/** Build the full inferred MONITORED_LOOPS entry for an unregistered cron loop. Pure + deterministic.
 *
 * coverage-register-always-platform (CEO directive, 2026-07): a monitored-loop entry is ALWAYS `platform`-
 * owned. The tile answers "is this cron still ALIVE" — a platform/infra-reliability concern that Ada owns —
 * regardless of which function's business the cron serves (a growth cron's LIVENESS is still platform's to
 * watch). So we no longer call `inferOwner` for the entry owner, and there is no low-confidence placeholder /
 * "REQUIRES OWNER CONFIRMATION" path: the owner is `platform`, confidently, every time. (`inferOwner` is kept
 * as a legacy domain classifier but is no longer used to own a loop tile.) */
export function inferLoopEntry(loopId: string, cadence: string, nowIso?: string): InferredLoopEntry {
  const { label, windowMs } = inferCadence(cadence);
  const owner: OwnerFunction = "platform"; // always platform — loop liveness is a platform-reliability concern.
  const entry: InferredLoopEntry = {
    id: loopId,
    kind: "cron",
    owner,
    label: loopId,
    description: `Auto-proposed monitored loop for the ${loopId} cron (${label}). Owned by platform (loop liveness monitoring); confirm the cadence/window.`,
    expectedCadence: label,
    livenessWindowMs: windowMs,
  };
  // Long-cadence crons need registeredAt to claim the registered_not_firing newcron grace.
  if (windowMs >= 6 * HOUR) entry.registeredAt = nowIso || new Date().toISOString();
  return entry;
}

/**
 * A monitored-loop entry's owner is ALWAYS `platform` now (coverage-register-always-platform), so the owner
 * is always confident — kept for the callers that gate an "owner confirmation" banner (now always true → no
 * banner). `inferOwner` remains a legacy domain classifier but no longer decides a loop tile's owner.
 */
export function isOwnerConfident(_loopId: string): boolean {
  return true;
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

/** Platform mandate the coverage-register fix specs live under — mirrors mario's fix-spec parent. The
 *  chokepoint's `assertValidParent` rejects a bare-function parent (`[[../functions/platform]]` alone)
 *  as free-text, so every autonomous author points at a mandate. */
const COVERAGE_FIX_MANDATE_SLUG = "infra-devops-reliability";
const COVERAGE_FIX_PARENT_PROSE =
  `[[../functions/platform]] — "Infra & DevOps / reliability" mandate (loop-coverage monitoring; ` +
  `auto-proposed by [[../libraries/coverage-register-agent]] from the [[control-tower-complete-coverage]] self-audit).`;

/**
 * The single-phase register fix spec, as a structured input to `authorSpecRowStructured`.
 *
 * every-spec-writer-authors-machine-runnable-verifications Phase 1 (coverage-register lane): the
 * phase carries a typed `exec_kind:'grep'` check asserting the loop id landed in
 * `src/lib/control-tower/registry.ts` (where `MONITORED_LOOPS` lives). The deterministic runner
 * executes this after merge; a still-missing entry fails the check without any prose reading.
 *
 * Verification prose is preserved alongside the typed check so the human-facing bullets keep working
 * during the migration window (the structured checks are the sole ship gate).
 */
export function buildRegisterSpecBody(entry: InferredLoopEntry): StructuredSpecInput {
  const why =
    `The \`${entry.id}\` cron runs in code with no monitored-loop tile, so if it silently stops ` +
    `firing nothing alerts us — a blind spot in platform coverage.`;
  const what =
    `Adds the \`${entry.id}\` entry to \`MONITORED_LOOPS\` so the loop becomes a health-tracked ` +
    `tile that alerts when it misses its ${entry.expectedCadence} cadence.`;

  const phaseBody =
    `In \`${COVERAGE_REGISTRY_FILE}\`, add this entry to \`MONITORED_LOOPS\` (in the Inngest ` +
    `crons group):\n\n\`\`\`ts\n${renderEntrySnippet(entry)}\n\`\`\`\n\n` +
    `No other change. After merge + deploy the amber "unregistered loop: ${entry.id}" gap clears ` +
    `and a \`${entry.id}\` cron tile appears.`;

  const verification =
    `- \`${entry.id}\` is present in \`${COVERAGE_REGISTRY_FILE}\` (the MONITORED_LOOPS entry landed).\n` +
    `- On /dashboard/developer/control-tower, the Coverage self-audit no longer lists "Unregistered loop: ${entry.id}".`;

  return {
    title: `Register monitored loop: ${entry.id}`,
    summary: null,
    owner: entry.owner,
    parent: COVERAGE_FIX_PARENT_PROSE,
    why,
    what,
    autoBuild: true,
    phases: [
      {
        title: `Phase 1 — add the MONITORED_LOOPS entry`,
        body: phaseBody,
        verification,
        why,
        what,
        status: "planned",
        checks: [
          {
            position: 1,
            description: `\`${entry.id}\` is present in \`${COVERAGE_REGISTRY_FILE}\` (the MONITORED_LOOPS entry landed).`,
            kind: "auto",
            exec_kind: "grep",
            params: {
              path: COVERAGE_REGISTRY_FILE,
              pattern: entry.id,
              expect: "present",
            },
          },
        ],
      },
    ],
  };
}

/**
 * The single-phase exempt fix spec, as a structured input to `authorSpecRowStructured`. The typed
 * grep check asserts the loop id landed in `src/lib/control-tower/registry.ts` — where
 * `INTENTIONALLY_UNMONITORED_CRONS` lives — so an added exemption row satisfies it.
 */
export function buildExemptSpecBody(loopId: string, owner: OwnerFunction): StructuredSpecInput {
  const why =
    `The coverage self-audit keeps flagging \`${loopId}\` as an unregistered loop, but the owner ` +
    `reviewed it and it does not need liveness monitoring — a registered exemption records ` +
    `"intentionally unmonitored" instead of leaving the gap flagged forever.`;
  const what =
    `Adds \`${loopId}\` to \`INTENTIONALLY_UNMONITORED_CRONS\` so the coverage audit stops ` +
    `flagging it as an unregistered loop.`;

  const phaseBody =
    `In \`${COVERAGE_REGISTRY_FILE}\`, add to \`INTENTIONALLY_UNMONITORED_CRONS\`:\n\n\`\`\`ts\n  ` +
    `${JSON.stringify(loopId)}: "intentionally unmonitored — owner-confirmed via the coverage-register agent",\n\`\`\`\n\n` +
    `No other change. After merge + deploy the audit no longer flags \`${loopId}\` as an unregistered loop.`;

  const verification =
    `- \`${loopId}\` is present in \`${COVERAGE_REGISTRY_FILE}\` (the INTENTIONALLY_UNMONITORED_CRONS entry landed).\n` +
    `- On /dashboard/developer/control-tower, the Coverage self-audit no longer lists "Unregistered loop: ${loopId}".`;

  return {
    title: `Exempt loop from coverage monitoring: ${loopId}`,
    summary: null,
    owner,
    parent: COVERAGE_FIX_PARENT_PROSE,
    why,
    what,
    autoBuild: true,
    phases: [
      {
        title: `Phase 1 — add the INTENTIONALLY_UNMONITORED_CRONS exemption`,
        body: phaseBody,
        verification,
        why,
        what,
        status: "planned",
        checks: [
          {
            position: 1,
            description: `\`${loopId}\` is present in \`${COVERAGE_REGISTRY_FILE}\` (the INTENTIONALLY_UNMONITORED_CRONS entry landed).`,
            kind: "auto",
            exec_kind: "grep",
            params: {
              path: COVERAGE_REGISTRY_FILE,
              pattern: loopId,
              expect: "present",
            },
          },
        ],
      },
    ],
  };
}

/** Typed `parentKind`/`parentRef` the runCoverageRegisterJob worker passes to `authorSpecRowStructured` so the
 *  chokepoint's `assertValidParent` accepts the mandate-anchored parent prose without falling back to auto-anchor. */
export const COVERAGE_FIX_PARENT_KIND = "mandate" as const;
export const COVERAGE_FIX_PARENT_REF = `platform#${COVERAGE_FIX_MANDATE_SLUG}` as const;

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
        register_spec_input: buildRegisterSpecBody(entry),
        exempt_spec_slug: exSlug,
        exempt_spec_input: buildExemptSpecBody(input.loopId, entry.owner),
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
