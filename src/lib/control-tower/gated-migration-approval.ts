/**
 * Gated-migration approval filing — the PURE half of the migration-drift reconciler's
 * `onApprovalNeeded` hook (scripts/builder-worker.ts `runMigrationDriftJob` →
 * `fileGatedMigrationApproval`).
 *
 * Before this existed, a merged-but-unapplied migration that `classifyMigrationSql` flagged
 * `reversible_destructive` / `irreversible_destructive` (the standard CHECK-widening pattern
 * `DROP CONSTRAINT IF EXISTS … ADD CONSTRAINT …` trips it) only got a `console.warn` — no approval
 * card, no agent_jobs row, nothing a human could tap. The file sat unapplied forever (the
 * 2026-10 `billing_alert` CHECK incident: every billing alert was rejected in prod while the fix
 * migration was merged but never applied).
 *
 * The fix REUSES the existing supervised out-of-leash approval rail rather than inventing a parallel
 * one: the hook inserts ONE `agent_jobs` row of kind `ceo-authorized-out-of-leash`
 * (status `needs_approval`) carrying ONE `apply_migration` pending action. The approval-inbox
 * reconciler (`reconcileApprovalInbox`) surfaces it as a routed Approval Request; `/api/roadmap/approve`
 * flips it to `queued_resume`; the box's `runCeoAuthorizedOutOfLeashJob` executes it — for an action
 * carrying the `migration_drift` marker it applies THAT file in-process via `applyMigrationAndRecord`
 * (statement-level apply + the `supabase_migrations.schema_migrations` ledger row), so the next drift
 * tick clears.
 *
 * Everything decision-shaped lives here as pure functions so it is unit-testable
 * (gated-migration-approval.test.ts):
 *   - `gatedMigrationDedupeKey`       — version + content hash (decline sticks until the file changes)
 *   - `decideGatedMigrationFiling`    — at most ONE approval per (version, content); re-ticks never fan out
 *   - `resolveGatedMigrationRoute`    — routeDestructiveAction + "dormant Platform ⇒ CEO" fail-safe
 *   - `buildGatedMigrationApprovalJob`— the agent_jobs row (card shows file, severity, matches, SQL preview)
 *   - `validateGatedMigrationExecution` — the executor's pre-apply re-check (same bytes the approver saw)
 *   - `isOutOfLeashExecutableClaimStatus` — the executor's entry guard (accepts the claimed `building` row)
 */
import { createHash } from "crypto";
import {
  routeDestructiveAction,
  type BlastRadius,
  type DestructiveRoute,
  type MigrationSeverity,
} from "@/lib/migration-safety";

/** The existing approval kind this rail rides (owner `ceo` in the node registry; executor lane exists). */
export const GATED_MIGRATION_JOB_KIND = "ceo-authorized-out-of-leash";
/** `instructions.origin` + the dedupe-key namespace that distinguishes drift-filed rows from Ask-Ada raises. */
export const GATED_MIGRATION_ORIGIN = "migration-drift";
/** How much of the SQL body the card carries (the inbox evidence block caps at 2500 chars). */
export const GATED_MIGRATION_SQL_PREVIEW_MAX = 1800;

/** A migration filename the executor is willing to touch: `YYYYMMDDNNNNNN_name.sql`, no path parts. */
const MIGRATION_FILE_RE = /^(\d{14})_[A-Za-z0-9_]+\.sql$/;

/** sha256 hex of the migration file's exact bytes. */
export function migrationContentHash(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Dedupe key for one gated migration: `migration-drift::<version>::<sha256[0..16]>`. Keyed on the
 * CONTENT so a decline sticks for those bytes, and an edited file (new hash) is a fresh ask.
 */
export function gatedMigrationDedupeKey(version: string, sql: string): string {
  return `${GATED_MIGRATION_ORIGIN}::${version}::${migrationContentHash(sql).slice(0, 16)}`;
}

/** The agent_jobs.spec_slug a drift-filed approval carries — the per-version lookup key. */
export function gatedMigrationSpecSlug(version: string): string {
  return `${GATED_MIGRATION_ORIGIN}:${version}`;
}

/** One previously-filed drift approval row, as read back off agent_jobs.instructions. */
export interface ExistingGatedMigrationRow {
  id: string;
  status: string;
  /** instructions.dedupe_key */
  dedupeKey: string | null;
  /** instructions.migration_version */
  version: string | null;
}

/** Parse one raw agent_jobs row (instructions JSON) into the dedupe input. Malformed JSON ⇒ null key. */
export function parseExistingGatedMigrationRow(row: {
  id: string;
  status: string;
  instructions: string | null;
}): ExistingGatedMigrationRow {
  let instr: Record<string, unknown> = {};
  try {
    instr = row.instructions ? (JSON.parse(row.instructions) as Record<string, unknown>) : {};
  } catch {
    /* malformed — key stays null */
  }
  return {
    id: row.id,
    status: row.status,
    dedupeKey: typeof instr.dedupe_key === "string" ? instr.dedupe_key : null,
    version: typeof instr.migration_version === "string" ? instr.migration_version : null,
  };
}

export type GatedMigrationFilingDecision =
  | { action: "file"; reason: string; supersedeIds: string[] }
  | { action: "skip"; reason: string; existingId: string; supersedeIds: string[] };

/** Statuses where the approval is still awaiting a human decision (a stale-content one gets superseded). */
const AWAITING_DECISION = new Set(["needs_approval"]);

/**
 * Decide whether to file a new approval for (version, dedupeKey), given every earlier drift-filed row
 * for the same version.
 *
 *  - ANY row with the same dedupe key, in ANY status → skip. Open (`needs_approval`) = already filed;
 *    `queued_resume`/`claimed` = decided, executing; `completed` = approved-and-applied or DECLINED
 *    (a decline is NOT re-filed for the same content); `needs_attention` = the approved apply failed and
 *    a human owns it. Re-ticks therefore never fan out.
 *  - Otherwise → file. Any still-open row for the same version with a DIFFERENT key (the file was edited
 *    after it was filed) is returned in `supersedeIds` so the caller closes it — one card per version.
 */
export function decideGatedMigrationFiling(
  existing: ExistingGatedMigrationRow[],
  input: { version: string; dedupeKey: string },
): GatedMigrationFilingDecision {
  const sameVersion = existing.filter((r) => r.version === input.version || (r.dedupeKey ?? "").startsWith(`${GATED_MIGRATION_ORIGIN}::${input.version}::`));
  const sameKey = sameVersion.find((r) => r.dedupeKey === input.dedupeKey);
  if (sameKey) {
    const why =
      AWAITING_DECISION.has(sameKey.status)
        ? "approval already open for this version + content"
        : sameKey.status === "completed"
          ? "already decided for this version + content (approved or declined) — not re-filed until the file changes"
          : `prior approval for this version + content is ${sameKey.status}`;
    return { action: "skip", reason: why, existingId: sameKey.id, supersedeIds: [] };
  }
  const supersedeIds = sameVersion
    .filter((r) => AWAITING_DECISION.has(r.status) && r.dedupeKey !== input.dedupeKey)
    .map((r) => r.id);
  return {
    action: "file",
    reason: supersedeIds.length
      ? `file content changed since the open approval — superseding ${supersedeIds.length} stale request(s)`
      : "no approval on file for this version + content",
    supersedeIds,
  };
}

export interface GatedMigrationRoute extends DestructiveRoute {
  /** What routeDestructiveAction alone said, before the dormant-Platform fail-safe. */
  baseRoutedToFunction: DestructiveRoute["routedToFunction"];
  /** True iff the dormant-Platform fail-safe flipped a Platform route to the CEO. */
  platformDormantFallback: boolean;
}

/**
 * Route the approval: `routeDestructiveAction` (severity × rename-and-expire × business-materiality)
 * decides Platform/Ada vs CEO; when it says Platform but Platform is NOT the live+autonomous
 * auto-approver (`platformIsAutoApprover(loadAutonomyMap())`), route to the CEO instead so the request
 * never waits on a dormant approver. Never widens a CEO route to Platform.
 */
export function resolveGatedMigrationRoute(input: {
  sql: string;
  blastRadius: BlastRadius;
  platformAutoApprover: boolean;
}): GatedMigrationRoute {
  const base = routeDestructiveAction(input.sql, input.blastRadius);
  if (base.routedToFunction === "platform" && !input.platformAutoApprover) {
    return {
      ...base,
      routedToFunction: "ceo",
      baseRoutedToFunction: "platform",
      platformDormantFallback: true,
      reason: `${base.reason}; Platform/Ada is not live+autonomous — routed to the CEO so it never waits on a dormant approver`,
    };
  }
  return { ...base, baseRoutedToFunction: base.routedToFunction, platformDormantFallback: false };
}

/** The marker carried on the pending action — the executor applies EXACTLY this file + content. */
export interface GatedMigrationMarker {
  version: string;
  file: string;
  content_hash: string;
}

export interface BuildGatedMigrationJobInput {
  workspaceId: string;
  version: string;
  file: string;
  sql: string;
  severity: MigrationSeverity;
  matches: string[];
  blastRadius: BlastRadius;
  route: GatedMigrationRoute;
}

export interface GatedMigrationJobRow {
  workspace_id: string;
  spec_slug: string;
  kind: typeof GATED_MIGRATION_JOB_KIND;
  status: "needs_approval";
  pending_actions: Array<Record<string, unknown>>;
  instructions: string;
  log_tail: string;
}

/** The literal the card shows after `$ ` — names the in-process apply the box runs on approval. */
export function gatedMigrationCmd(file: string): string {
  return `applyMigrationAndRecord supabase/migrations/${file}  # box in-process: statement-level apply + schema_migrations ledger row`;
}

/** The SQL body bounded for the card. */
export function gatedMigrationSqlPreview(sql: string, max = GATED_MIGRATION_SQL_PREVIEW_MAX): string {
  const s = sql.trim();
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated — ${s.length - max} more chars in supabase/migrations)`;
}

/**
 * Build the `agent_jobs` insert for one gated migration. The approval-inbox card renders the action's
 * `summary` (the ask — file + severity), `$ cmd`, then `preview` (file, severity, classifier matches,
 * routing reason, SQL preview). `routed_to_function_override` + `blastRadius` follow the existing
 * out-of-leash shape so `routingOwnerForJob` re-validates the route at read time (only a
 * `reversible_destructive` apply_migration may hold a Platform override).
 */
export function buildGatedMigrationApprovalJob(input: BuildGatedMigrationJobInput): GatedMigrationJobRow {
  const contentHash = migrationContentHash(input.sql);
  const dedupeKey = gatedMigrationDedupeKey(input.version, input.sql);
  const cmd = gatedMigrationCmd(input.file);
  const matchesText = input.matches.length ? input.matches.join(", ") : "(none)";
  const routedTag = input.route.routedToFunction === "ceo" ? "CEO" : "Platform / Ada (final call)";
  const irreversible = input.severity === "irreversible_destructive";
  const summary = `Apply gated migration ${input.file} (${input.severity})${irreversible ? "  ⚠ irreversible" : ""}`;
  const preview = [
    `Merged to main but NOT applied — the migration-drift reconciler will not auto-apply it because the destructive-SQL classifier flagged it. Approving applies this exact file once on the box and records the ledger row; declining leaves it unapplied (not re-asked until the file changes).`,
    `File: supabase/migrations/${input.file}`,
    `Version: ${input.version} · sha256 ${contentHash.slice(0, 16)}`,
    `Severity: ${input.severity}`,
    `Classifier matches: ${matchesText}`,
    `Routing → ${routedTag}: ${input.route.reason}`,
    `SQL:\n${gatedMigrationSqlPreview(input.sql)}`,
  ].join("\n");
  const marker: GatedMigrationMarker = { version: input.version, file: input.file, content_hash: contentHash };
  const pendingAction: Record<string, unknown> = {
    id: `gm${input.version}${contentHash.slice(0, 6)}`,
    type: "apply_migration",
    summary,
    cmd,
    preview,
    status: "pending",
    out_of_leash: true,
    authorized_by: "ceo-pending",
    irreversible,
    reversibility: input.blastRadius.summary,
    blastRadius: input.blastRadius,
    routed_to_function_override: input.route.routedToFunction,
    destructive_route: input.route,
    migration_drift: marker,
  };
  const instructions = JSON.stringify({
    origin: GATED_MIGRATION_ORIGIN,
    director_function: "platform",
    action_type: "apply_migration",
    cmd,
    reasoning: `migration-drift: ${input.file} is merged-but-unapplied and classifyMigrationSql flagged ${input.severity} (${matchesText}) — gated for a human decision instead of auto-applied.`,
    reversibility: input.blastRadius.summary,
    irreversible,
    out_of_leash: true,
    authorized_by: "ceo-pending",
    dedupe_key: dedupeKey,
    migration_version: input.version,
    migration_file: input.file,
    content_hash: contentHash,
    blast_radius: input.blastRadius,
    destructive_route: input.route,
  });
  const logTail = [
    `🛠️ migration-drift filed a gated-migration Approval Request → ${routedTag}.`,
    `File: ${input.file} (version ${input.version})`,
    `Severity: ${input.severity} · matches: ${matchesText}`,
    `Routing: ${input.route.reason}`,
    `$ ${cmd}`,
  ].join("\n");
  return {
    workspace_id: input.workspaceId,
    spec_slug: gatedMigrationSpecSlug(input.version),
    kind: GATED_MIGRATION_JOB_KIND,
    status: "needs_approval",
    pending_actions: [pendingAction],
    instructions,
    log_tail: logTail.slice(-2000),
  };
}

/** Read the marker off a pending action; null when absent/malformed. */
export function readGatedMigrationMarker(action: Record<string, unknown>): GatedMigrationMarker | null {
  const m = action["migration_drift"];
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  if (typeof r.version !== "string" || typeof r.file !== "string" || typeof r.content_hash !== "string") return null;
  return { version: r.version, file: r.file, content_hash: r.content_hash };
}

export type GatedMigrationExecutionCheck =
  | { ok: true }
  | { ok: false; outcome: "invalid" | "missing" | "content-changed" | "already-applied"; reason: string };

/**
 * The executor's pre-apply re-check, run on the box after approval and BEFORE any DDL:
 *  - the marker names a bare `YYYYMMDDNNNNNN_name.sql` whose prefix is the version (no path traversal);
 *  - the file still exists on main (`onDiskSql` non-null);
 *  - its bytes hash to what the approver saw (an edit after filing ⇒ refuse; the next tick files a fresh card);
 *  - the version isn't already in the ledger (a concurrent apply ⇒ nothing to do, report it, don't re-run).
 * `appliedVersions === null` means the ledger couldn't be read — proceed (applyMigrationAndRecord records
 * conflict-safely and its statement-level duplicate-object handling covers a raced apply).
 */
export function validateGatedMigrationExecution(input: {
  marker: GatedMigrationMarker;
  onDiskSql: string | null;
  appliedVersions: ReadonlySet<string> | null;
}): GatedMigrationExecutionCheck {
  const { marker } = input;
  const m = MIGRATION_FILE_RE.exec(marker.file);
  if (!m || m[1] !== marker.version) {
    return { ok: false, outcome: "invalid", reason: `refusing malformed migration marker (file='${marker.file}', version='${marker.version}')` };
  }
  if (input.onDiskSql === null) {
    return { ok: false, outcome: "missing", reason: `supabase/migrations/${marker.file} no longer exists on main` };
  }
  if (migrationContentHash(input.onDiskSql) !== marker.content_hash) {
    return {
      ok: false,
      outcome: "content-changed",
      reason: `supabase/migrations/${marker.file} changed since this approval was filed — not applying; the next drift tick files a fresh request for the new content`,
    };
  }
  if (input.appliedVersions && input.appliedVersions.has(marker.version)) {
    return { ok: false, outcome: "already-applied", reason: `version ${marker.version} is already in supabase_migrations.schema_migrations — nothing to apply` };
  }
  return { ok: true };
}

/**
 * Entry guard for `runCeoAuthorizedOutOfLeashJob`. A `ceo-authorized-out-of-leash` row is inserted
 * `needs_approval` (not claimable); `/api/roadmap/approve` flips it to `queued_resume` once every
 * action is decided; `claim_agent_job` then flips it to `building` and returns THAT row. So the row the
 * executor receives is `building`. The old guard accepted only `queued_resume`, so every approved
 * out-of-leash action (gated migrations included) was skipped and left `building` until the reaper
 * re-queued it, forever (2026-10-15: four approved gated migrations never applied). `queued_resume`
 * stays accepted for a direct (unclaimed) dispatch.
 */
export function isOutOfLeashExecutableClaimStatus(status: string | null | undefined): boolean {
  return status === "building" || status === "queued_resume";
}
