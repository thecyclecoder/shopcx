/**
 * spec-phase-checks-table — SDK for `public.spec_phase_checks` (pm-structured-intent-and-refs
 * Phase 3), the structured replacement for the free-text `spec_phases.verification` blob.
 *
 * One row per verification check on a phase — `{position, description, kind}`. `kind='auto'` means
 * the spec-test agent runs it directly (non-destructive); `kind='human'` parks it needs_human. The
 * upsert rule mirrors `spec_phases`: replace-by-position preserves stable ids on re-author.
 *
 * The author chokepoint ([[author-spec]] `assertEveryPhaseHasChecks`) gates ≥1 check per phase —
 * same rail as the existing verification-text gate. Both surfaces are written during the migration
 * window so legacy readers keep functioning.
 *
 * Service-role only via `createAdminClient()`.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type SpecPhaseCheckKind = "auto" | "human";

/**
 * machine-declared-verification Phase 1 — the RUNNABLE kind on `spec_phase_checks.exec_kind` read by
 * the deterministic Node spec-check runner (Phase 2). Coexists with the coarse `kind` ('auto'|'human')
 * during the migration window: `kind` stays the display/chip category; `exec_kind` decides EXECUTION.
 * `needs_human` is the safe default — nothing auto-runs on undeclared / prose / subjective / drift.
 */
export type SpecPhaseCheckExecKind =
  | "tsc"
  | "grep"
  | "ci_status"
  | "http_get"
  | "db_probe_readonly"
  | "unit_test"
  | "build"
  | "needs_human";

/** Kinds the deterministic runner MAY execute (everything else falls through to needs_human). */
export const AUTO_TESTABLE_EXEC_KINDS: readonly SpecPhaseCheckExecKind[] = [
  "tsc",
  "grep",
  "ci_status",
  "http_get",
  "db_probe_readonly",
  "unit_test",
  "build",
] as const;

export interface GrepCheckParams {
  pattern: string;
  path?: string;
  expect: "present" | "absent";
}
export interface HttpGetCheckParams {
  url: string;
  expect_status: number;
}
export interface DbProbeReadonlyCheckParams {
  sql: string;
  expect: unknown;
}
export interface UnitTestCheckParams {
  script: string;
}
export type SpecPhaseCheckParams =
  | GrepCheckParams
  | HttpGetCheckParams
  | DbProbeReadonlyCheckParams
  | UnitTestCheckParams
  | null;

export interface SpecPhaseCheckRow {
  id: string;
  phase_id: string;
  position: number;
  description: string;
  kind: SpecPhaseCheckKind;
  exec_kind: SpecPhaseCheckExecKind | null;
  params: SpecPhaseCheckParams;
  created_at: string;
  updated_at: string;
}

export interface SpecPhaseCheckInput {
  position: number;
  description: string;
  kind: SpecPhaseCheckKind;
  exec_kind?: SpecPhaseCheckExecKind | null;
  params?: SpecPhaseCheckParams;
}

/**
 * REPLACE-by-position rule (mirrors `upsertSpec` on phases): matching positions UPDATE in place
 * (stable id preserved), new positions INSERT, vanished positions DELETE. Idempotent.
 *
 * Passing `checks: []` clears every check for the phase. The author chokepoint is responsible for
 * gating "≥1 check per phase" — this writer accepts what it's told.
 */
export async function upsertPhaseChecks(phaseId: string, checks: SpecPhaseCheckInput[]): Promise<void> {
  const admin = createAdminClient();
  const { data: existing, error: exErr } = await admin
    .from("spec_phase_checks")
    .select("id, position")
    .eq("phase_id", phaseId);
  if (exErr) throw exErr;
  const byPosition = new Map<number, string>();
  for (const p of (existing ?? []) as { id: string; position: number }[]) byPosition.set(p.position, p.id);

  const inputPositions = new Set(checks.map((c) => c.position));
  const toDelete: number[] = [];
  for (const pos of byPosition.keys()) if (!inputPositions.has(pos)) toDelete.push(pos);
  if (toDelete.length) {
    const { error: dErr } = await admin
      .from("spec_phase_checks")
      .delete()
      .eq("phase_id", phaseId)
      .in("position", toDelete);
    if (dErr) throw dErr;
  }

  for (const c of checks) {
    const existingId = byPosition.get(c.position);
    // machine-declared-verification Phase 1 — carry the executable payload (exec_kind + params). Both are
    // additive/nullable; a caller who does not know the executable kind writes null and the runner treats
    // it as needs_human (the safe default, same as an undeclared prose check).
    const execKind: SpecPhaseCheckExecKind | null = c.exec_kind ?? null;
    const params: SpecPhaseCheckParams = c.params ?? null;
    if (existingId) {
      const { error: uErr } = await admin
        .from("spec_phase_checks")
        .update({
          description: c.description,
          kind: c.kind,
          exec_kind: execKind,
          params: params as unknown,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingId);
      if (uErr) throw uErr;
    } else {
      const { error: iErr } = await admin.from("spec_phase_checks").insert({
        phase_id: phaseId,
        position: c.position,
        description: c.description,
        kind: c.kind,
        exec_kind: execKind,
        params: params as unknown,
      });
      if (iErr) throw iErr;
    }
  }
}

export async function listPhaseChecks(phaseId: string): Promise<SpecPhaseCheckRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("spec_phase_checks")
    .select("id, phase_id, position, description, kind, exec_kind, params, created_at, updated_at")
    .eq("phase_id", phaseId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data as SpecPhaseCheckRow[]) ?? [];
}

/**
 * verification-checks-source-of-truth — batched `phase_id → [{position, description}]` map (position order)
 * for the renderer. `renderSpecRow` uses it to emit `### Verification` from the typed rows (the DB object),
 * falling back to the `verification` column for phases with no rows. Empty map when `phaseIds` is empty.
 */
export async function checksByPhaseIdForRender(
  phaseIds: string[],
): Promise<Map<string, { description: string }[]>> {
  const out = new Map<string, { description: string }[]>();
  if (!phaseIds.length) return out;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("spec_phase_checks")
    .select("phase_id, position, description")
    .in("phase_id", phaseIds)
    .order("position", { ascending: true });
  if (error) throw error;
  for (const r of (data ?? []) as { phase_id: string; position: number; description: string }[]) {
    const list = out.get(r.phase_id) ?? [];
    list.push({ description: r.description });
    out.set(r.phase_id, list);
  }
  return out;
}

/**
 * One row per verification check across every phase of a spec — the rows-first replacement for
 * parsing `## Verification` bullets out of markdown (pm-structured-intent-and-refs Phase 3).
 *
 * Rows: batched read of `spec_phase_checks` for every phase, then interleaved in phase order. During
 * the migration window a phase MAY still carry only `spec_phases.verification` prose (rows haven't
 * been backfilled yet) — those fall back to `parseVerificationBlobToChecks(phase.verification)`, which
 * is column-derived (a DB column read + line-split), NEVER a load-bearing markdown parse of the
 * rendered spec body. Once every phase has rows the fallback is unreachable and can be dropped.
 */
export interface SpecCheckForListing {
  /** Bullet text used both for display and for `checkKey` (matches the spec-test agent's check.text). */
  text: string;
  /** 'auto' → non-destructive machine check · 'human' → owner-verified. Drives the check chip category. */
  kind: SpecPhaseCheckKind;
  /** 1-based phase position; disambiguates duplicate check text across phases. */
  phasePosition: number;
}

export async function listSpecPhaseChecks(spec: {
  phases: { id: string; position: number; verification: string | null }[];
}): Promise<SpecCheckForListing[]> {
  const admin = createAdminClient();
  const phaseIds = spec.phases.map((p) => p.id).filter(Boolean);
  const rowsByPhase = new Map<string, SpecPhaseCheckRow[]>();
  if (phaseIds.length) {
    const { data, error } = await admin
      .from("spec_phase_checks")
      .select("id, phase_id, position, description, kind, exec_kind, params, created_at, updated_at")
      .in("phase_id", phaseIds)
      .order("position", { ascending: true });
    if (error) throw error;
    for (const r of (data as SpecPhaseCheckRow[]) ?? []) {
      const list = rowsByPhase.get(r.phase_id) ?? [];
      list.push(r);
      rowsByPhase.set(r.phase_id, list);
    }
  }
  const out: SpecCheckForListing[] = [];
  for (const p of [...spec.phases].sort((a, b) => a.position - b.position)) {
    const rows = rowsByPhase.get(p.id) ?? [];
    if (rows.length) {
      for (const r of rows) {
        out.push({ text: r.description, kind: r.kind, phasePosition: p.position });
      }
    } else if (p.verification && p.verification.trim()) {
      // Transitional fallback: column-derived (a `spec_phases.verification` DB read), NOT a parse of
      // the rendered spec markdown. Once every phase has rows this branch is unreachable.
      for (const c of parseVerificationBlobToChecks(p.verification)) {
        out.push({ text: c.description, kind: c.kind, phasePosition: p.position });
      }
    }
  }
  return out;
}

/**
 * Best-effort backfill helper: split a free-text verification blob into per-check rows. Splits on
 * bullet lines (`- ` / `* `); an empty blob returns []. `kind` defaults to `auto` (the coarse
 * display/chip category — the spec-test agent re-classifies to `human` when it can't run it).
 *
 * machine-declared-verification Phase 1 — `exec_kind` defaults to `'needs_human'` for un-typed prose
 * (the deterministic runner NEVER auto-runs a check whose params it did not receive). Only the
 * structured author path (`checks: [{ exec_kind, params }]`) opts a check into deterministic execution;
 * prose falls through to the LLM residual, which is the exact safe default that closes the cs-director
 * `npm test` class (a mistyped command never lands as an auto-testable check).
 */
export function parseVerificationBlobToChecks(blob: string | null | undefined): SpecPhaseCheckInput[] {
  if (!blob || !blob.trim()) return [];
  const out: SpecPhaseCheckInput[] = [];
  let cur: string[] | null = null;
  const push = () => {
    if (!cur) return;
    const text = cur.join(" ").replace(/\s+/g, " ").trim();
    if (text)
      out.push({
        position: out.length + 1,
        description: text,
        kind: "auto",
        exec_kind: "needs_human",
        params: null,
      });
    cur = null;
  };
  for (const raw of blob.split("\n")) {
    const line = raw.trim();
    if (!line) { push(); continue; }
    if (/^[-*]\s+/.test(line)) {
      push();
      cur = [line.replace(/^[-*]\s+/, "")];
    } else if (cur) {
      cur.push(line);
    } else {
      // No leading bullet — treat the whole trimmed line as one check.
      cur = [line];
      push();
    }
  }
  push();
  return out;
}

// ── machine-declared-verification Phase 1 — validateExecutableCheck ──────────────────────────────
//
// Pure predicate asserting that a check's (exec_kind, params) pair is a well-formed executable
// payload the deterministic runner (Phase 2) can execute. Enforced app-layer so the shape doubles
// as the schema (no jsonb schema constraint — Postgres cannot express "params.expect is
// 'present'|'absent'"). Called by the author chokepoint and any surface that lands a new check.
//
// Rules per spec:
//   - grep              → { pattern: string, path?: string, expect: 'present'|'absent' }
//   - http_get          → { url: string, expect_status: number }
//   - db_probe_readonly → { sql: <plain SELECT / WITH …>, expect: <anything> } — RUNTIME-safe: any
//                         write / mutating verb rejects up front, closing the mutating-db class.
//   - unit_test         → { script: <a real package.json script> } — packageScripts must be passed;
//                         a script name absent from package.json rejects (closes the cs-director
//                         `npm test` class at authoring, not at runtime).
//   - tsc / build       → params null (no params needed).
//   - needs_human       → params null. NEVER auto-run. Accepted so a subjective/drift check has a
//                         well-formed row; the runner routes it to the LLM residual.
//   - unknown / null    → rejected.

export type ExecutableCheckValidation = { valid: true } | { valid: false; reason: string };

/**
 * Reject anything that isn't a plain read-only SELECT / WITH (CTE) statement. Substring-based on
 * purpose — a false-positive here (e.g. a column literally named "insert_at") fails CLOSED into
 * `needs_human`, which is the safe direction. The final `;` is tolerated; anything after it is not.
 */
export function isPlainReadonlySql(sql: string): boolean {
  const s = sql.trim().replace(/;\s*$/, "").trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (!(lower.startsWith("select") || lower.startsWith("with"))) return false;
  // any second statement disqualifies (a `;` in the middle chains a second command)
  if (/;\s*\S/.test(s)) return false;
  // Word-boundary match on any mutating verb / DDL.
  const mutating = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|lock|copy|merge|do|call|reindex|vacuum|analyze|refresh|comment)\b/i;
  if (mutating.test(s)) return false;
  return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateExecutableCheck(
  check: { exec_kind: SpecPhaseCheckExecKind | null | undefined; params?: unknown },
  ctx?: { packageScripts?: ReadonlySet<string> },
): ExecutableCheckValidation {
  const kind = check.exec_kind;
  if (!kind) return { valid: false, reason: "exec_kind is required" };
  const params = check.params;
  switch (kind) {
    case "tsc":
    case "build": {
      if (params !== null && params !== undefined) {
        return { valid: false, reason: `${kind} takes no params` };
      }
      return { valid: true };
    }
    case "needs_human": {
      if (params !== null && params !== undefined) {
        return { valid: false, reason: "needs_human takes no params (never auto-run)" };
      }
      return { valid: true };
    }
    case "grep": {
      if (!isRecord(params)) return { valid: false, reason: "grep requires { pattern, expect } params" };
      const { pattern, path, expect } = params as Record<string, unknown>;
      if (typeof pattern !== "string" || !pattern.trim()) {
        return { valid: false, reason: "grep.pattern must be a non-empty string" };
      }
      if (path !== undefined && (typeof path !== "string" || !path.trim())) {
        return { valid: false, reason: "grep.path (if set) must be a non-empty string" };
      }
      if (expect !== "present" && expect !== "absent") {
        return { valid: false, reason: "grep.expect must be 'present' or 'absent'" };
      }
      return { valid: true };
    }
    case "ci_status": {
      if (params !== null && params !== undefined) {
        return { valid: false, reason: "ci_status takes no params (branch derived by runner)" };
      }
      return { valid: true };
    }
    case "http_get": {
      if (!isRecord(params)) return { valid: false, reason: "http_get requires { url, expect_status }" };
      const { url, expect_status } = params as Record<string, unknown>;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        return { valid: false, reason: "http_get.url must be a full http(s):// URL" };
      }
      if (typeof expect_status !== "number" || !Number.isInteger(expect_status) ||
          expect_status < 100 || expect_status > 599) {
        return { valid: false, reason: "http_get.expect_status must be an HTTP status integer" };
      }
      return { valid: true };
    }
    case "db_probe_readonly": {
      if (!isRecord(params)) return { valid: false, reason: "db_probe_readonly requires { sql, expect }" };
      const { sql } = params as Record<string, unknown>;
      if (typeof sql !== "string" || !sql.trim()) {
        return { valid: false, reason: "db_probe_readonly.sql must be a non-empty string" };
      }
      if (!isPlainReadonlySql(sql)) {
        return { valid: false, reason: "db_probe_readonly.sql must be a plain read-only SELECT" };
      }
      if (!("expect" in (params as Record<string, unknown>))) {
        return { valid: false, reason: "db_probe_readonly.expect is required (may be null)" };
      }
      return { valid: true };
    }
    case "unit_test": {
      if (!isRecord(params)) return { valid: false, reason: "unit_test requires { script }" };
      const { script } = params as Record<string, unknown>;
      if (typeof script !== "string" || !script.trim()) {
        return { valid: false, reason: "unit_test.script must be a non-empty string" };
      }
      // Closes the cs-director `npm test` class at authoring — a script name absent from
      // package.json is rejected here, not silently mis-run at Vera time.
      const scripts = ctx?.packageScripts;
      if (scripts && !scripts.has(script)) {
        return {
          valid: false,
          reason: `unit_test.script "${script}" is not a package.json script`,
        };
      }
      return { valid: true };
    }
    default: {
      const never: never = kind;
      return { valid: false, reason: `unknown exec_kind: ${String(never)}` };
    }
  }
}
