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
import {
  DB_PROBES,
  containsSensitiveColumn,
  isRegisteredProbe,
  listRegisteredProbes,
} from "@/lib/spec-check-db-probes";

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
/**
 * db_probe_readonly now names a probe from the [[spec-check-db-probes]] registry — the
 * runner NEVER executes spec-authored SQL. Closes the pre-merge Vault findings on
 * spec-check-runner.ts:320/325/332 (injection · secret_leak · authz_rls ·
 * unsafe_admin_client · crypto_encrypted) that flagged the previous free-form
 * `{ sql: string }` path. See docs/brain/libraries/spec-check-db-probes.md.
 */
export interface DbProbeReadonlyCheckParams {
  /** Must be a key of `DB_PROBES` in [[spec-check-db-probes]]. Unknown ids reject. */
  probe_id: string;
  /** Scalar-only bound args for the probe. Sensitive-looking arg names reject. */
  args?: Record<string, string | number | boolean>;
  /** Scalar value the probe's returned `value` is deep-equal-compared to (number | boolean | null). */
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
//   - db_probe_readonly → { probe_id: <key of DB_PROBES>, args?, expect: number|boolean|null } — the
//                         SQL is fixed by the registered probe; unknown ids + sensitive arg names
//                         reject. Closes the pre-merge Vault findings on spec-check-runner.ts
//                         320/325/332 (injection · secret_leak · authz_rls · unsafe_admin_client ·
//                         crypto_encrypted); [[spec-check-db-probes]] is the allowlist.
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

/**
 * Reject any grep.path a spec author could weaponize into ripgrep option/preprocessor injection or
 * repo escape — an absolute path, a NUL-embedded path, a `..` segment that traverses outside the
 * repo, an option-looking leading '-', or empty-after-normalization. The runner also passes the
 * value after an argv `--` separator (see `defaultExecutors.grep` in [[spec-check-runner]]), but
 * this predicate is the primary gate: a rejected path never reaches spawn at all.
 */
export function validateGrepPath(path: unknown): ExecutableCheckValidation {
  if (typeof path !== "string") {
    return { valid: false, reason: "grep.path (if set) must be a non-empty string" };
  }
  const trimmed = path.trim();
  if (!trimmed) {
    return { valid: false, reason: "grep.path (if set) must be a non-empty string" };
  }
  if (trimmed.includes("\0")) {
    return { valid: false, reason: "grep.path must not contain NUL" };
  }
  if (trimmed.startsWith("-")) {
    return {
      valid: false,
      reason: "grep.path must not start with '-' (would be parsed by ripgrep as an option/preprocessor)",
    };
  }
  if (trimmed.startsWith("/")) {
    return { valid: false, reason: "grep.path must be repo-relative, not absolute" };
  }
  // Normalize .. traversal against a virtual repo root — any segment that pops above the root
  // rejects. Splits on '/' (POSIX) so a Windows-style '\\' inside a path stays a data character
  // and is still refused later by rg as a non-existent file, not silently traversed.
  const segments = trimmed.split("/");
  let depth = 0;
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      depth--;
      if (depth < 0) {
        return { valid: false, reason: "grep.path must not traverse outside the repo (has '..' above root)" };
      }
      continue;
    }
    depth++;
  }
  return { valid: true };
}

/**
 * verification-check-must-not-demand-a-name-the-builder-has-to-guess Phase 1 — reject a `grep` whose
 * `pattern` pins an EXACT LITERAL for a name the implementation gets to invent (an npm script name, a
 * `*.test.ts` filename, a kebab-case slug, a camelCase symbol) when the spec body does NOT itself pin
 * that name. Two specs each burned 5 builds on this shape: a check for `test:graduate-crowned` in
 * `package.json` while the correct implementation registered `test:media-buyer-graduate-scaler`, and a
 * check for `quant-desk` where the lifecycle page was authored as `Quant-desk`. No LLM pass will guess
 * one specific kebab string — the check is a lottery, not a verification, so it must fail at authoring.
 *
 * Returns `null` when the pattern is fine (regex-flavored, spec-pinned, or not a builder-invented shape);
 * a suggestion otherwise. Callers surface `reason` (the diagnosis) with `suggested` (the fix) so the
 * author sees the corrected pattern — a rejection that hides the fix just moves the guessing.
 *
 * Case-sensitivity is the same trap: `quant-desk` vs `Quant-desk`. The suggested pattern for a bare
 * kebab-case literal is case-insensitive so a downstream author defaulting to it stays right when the
 * downstream artifact is capitalized.
 */
const GREP_REGEX_METACHARS = /[.*|[\]\\+?(){}^$]/;

export function detectBuilderChosenNameInGrep(
  pattern: string,
  specText?: string,
): { reason: string; suggested: string } | null {
  const p = pattern.trim();
  if (!p) return null;
  // Spec-pinned escape valve: when the spec body (why / what / phase text) literally names this string,
  // the author has FIXED the name, not guessed it. Case-insensitive match — `consumeRedemption` in the
  // spec body still pins a grep for `consumeRedemption` regardless of how the body typed it. Runs
  // FIRST so a spec-pinned filename (which carries `.` as a "regex metachar") still opts out.
  if (specText && specText.toLowerCase().includes(p.toLowerCase())) return null;

  // test-file name — `<base>.test.ts` / `.spec.ts` / etc. Matched BEFORE the metachar guard: the `.`
  // in `scaler.test.ts` is intent-literal (the author wants the exact filename) even though `.`
  // reads as any-char in regex, and that discrepancy is itself part of the bug — the check pins a
  // specific basename regardless. Builder gets to choose the basename.
  const testFile = /^([a-z0-9][a-z0-9\-_]*)\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/i.exec(p);
  if (testFile) {
    const tokens = testFile[1].split(/[-_.]/).filter(Boolean);
    const distinctive = tokens[tokens.length - 1] || testFile[1];
    return {
      reason:
        `grep.pattern "${p}" pins a test filename the builder gets to invent — the correct ` +
        `implementation may pick any equivalent basename. Use a regex on the distinctive token, ` +
        `or name the exact filename in the spec body so the check is spec-pinned`,
      suggested: `${distinctive}\\.${testFile[2]}\\.`,
    };
  }

  // grep-check-guess-guard-closes-alternation-and-pin-gaps Phase 1 — a top-level `|` alternation of
  // TWO OR MORE bare-literal branches is not "a real pattern" (which is the theory the metachar bail
  // rides on); it is several guesses joined by a pipe, and it reads as *more* thorough than a single
  // name while being just as unmatchable. The 2026-08-02 live-guard measurement:
  // `verifyMutation|verifyContractState|assertLineState` was ALLOWED (waved through by the metachar
  // bail); `verifyContractState` alone was FLAGGED. That is the hole this closes.
  //
  // Conservative rule so a legitimate alternation stays legal:
  //   • split ONLY on top-level `|` (no groups, no anchors, no metachars other than the pipe itself)
  //   • require ≥ 2 non-empty branches
  //   • each branch itself must be a bare literal (no metachars) — a branch like `test:\\w+` means
  //     the author is expressing a real pattern, so we do not touch it
  //   • judge each branch through the same per-name rules by recursing WITH the spec text — if ANY
  //     branch is spec-pinned or is not a builder-chosen shape (single word, ALL_CAPS, etc), the
  //     whole pattern stays allowed (a real alternation with one genuine term)
  //   • only reject when EVERY branch flags — then suggest a corrected pattern built from the
  //     branches' distinctive tokens, joined with `|`, matching the style the existing rules emit
  const branches = p.split("|");
  if (branches.length >= 2 && branches.every((b) => b.length > 0 && !GREP_REGEX_METACHARS.test(b))) {
    const perBranch = branches.map((b) => detectBuilderChosenNameInGrep(b, specText));
    if (perBranch.every((g) => g !== null)) {
      const distinctives = perBranch.map((g, i) => {
        const s = g!.suggested;
        // Strip regex noise the per-name rules add so the suggested alternation reads as a proper
        // token list (e.g. `test:.*crowned` → `crowned`, `(?i)\\bquant-desk\\b` → `quant-desk`).
        const stripped = s
          .replace(/^\(\?i\)/, "")
          .replace(/^\\b/, "")
          .replace(/\\b$/, "")
          .replace(/^test:\.\*/, "")
          .replace(/^([^.\\]+)\\\..*$/, "$1");
        return stripped || branches[i]!;
      });
      return {
        reason:
          `grep.pattern "${p}" is an alternation of ${branches.length} names the builder gets to ` +
          `invent — each branch flags in isolation, so the union is a lottery, not a verification ` +
          `(joining guesses by "|" reads more thorough while staying just as unmatchable). Name ` +
          `the exact identifiers in the spec body so the check is spec-pinned, or loosen the ` +
          `pattern to a case-insensitive regex on the distinctive tokens`,
        suggested: `(?i)\\b(${distinctives.join("|")})\\b`,
      };
    }
  }

  // A pattern that already carries any regex metacharacter (beyond the filename shape above) is
  // not a bare literal — treat it as a pattern and stop.
  if (GREP_REGEX_METACHARS.test(p)) return null;

  // npm script name — `test:<slug>`. The exact shape that stranded 5 builds on
  // `bianca-actually-graduates-crowned-winners-...`. Suggest a regex on the distinctive tail token.
  const npm = /^test:([a-z0-9]+(?:[-_][a-z0-9]+)+)$/i.exec(p);
  if (npm) {
    const tokens = npm[1].split(/[-_]/).filter(Boolean);
    const distinctive = tokens[tokens.length - 1] || npm[1];
    return {
      reason:
        `grep.pattern "${p}" pins an npm script name the builder gets to invent — a correct ` +
        `build may register an equivalent name (e.g. "test:media-buyer-${distinctive}") and no LLM ` +
        `pass will guess this exact string. Use a regex on the distinctive token, or name the ` +
        `exact script in the spec body so the check is spec-pinned rather than author-guessed`,
      suggested: `test:.*${distinctive}`,
    };
  }

  // kebab-case multi-token slug — the `quant-desk` class. Casing alone breaks the match
  // ("Quant-desk" ≠ "quant-desk"); loosen with a case-insensitive regex on the distinctive token.
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i.test(p)) {
    const tokens = p.split("-").filter(Boolean);
    const distinctive = tokens.reduce((a, b) => (b.length > a.length ? b : a), tokens[0]);
    return {
      reason:
        `grep.pattern "${p}" is a bare kebab-case name the builder chooses — casing alone breaks ` +
        `the match ("${p.charAt(0).toUpperCase() + p.slice(1)}" ≠ "${p}"), and equivalent naming ` +
        `(underscore / space / synonym) fails the same way. Loosen the pattern with a ` +
        `case-insensitive regex on a distinctive token, or name the exact string in the spec body`,
      suggested: `(?i)\\b${distinctive}\\b`,
    };
  }

  // camelCase / PascalCase multi-word symbol — legitimate ONLY when the spec body pins it as required
  // API. Requires a real lowercase→uppercase transition ("handleRedemption", "HandleRedemption",
  // "chunkSize123") so ALL-CAPS constants ("SELECT", "MAX_ATTEMPTS") and single PascalCase words
  // ("Phase", "Redemption") stay unflagged — those are not builder-invented multi-word symbols.
  if (/^[a-zA-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*$/.test(p)) {
    return {
      reason:
        `grep.pattern "${p}" is a camelCase symbol the builder chooses — the spec body does not ` +
        `pin this exact identifier, so a correct implementation may use an equivalent name. Name ` +
        `the exact symbol in the spec body if it is required API, or loosen the pattern`,
      suggested: p,
    };
  }

  return null;
}

export function validateExecutableCheck(
  check: { exec_kind: SpecPhaseCheckExecKind | null | undefined; params?: unknown },
  ctx?: { packageScripts?: ReadonlySet<string>; specText?: string },
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
      if (path !== undefined) {
        // grep.path flows into `rg` as a raw argument, so treat it as an untrusted capability
        // boundary — a spec-authored value must be a safe repo-relative path and can NEVER be
        // parsable by ripgrep as an option/preprocessor. `--` in the argv (see the executor)
        // is defense-in-depth; this predicate is the first gate.
        const pathCheck = validateGrepPath(path);
        if (!pathCheck.valid) return pathCheck;
      }
      if (expect !== "present" && expect !== "absent") {
        return { valid: false, reason: "grep.expect must be 'present' or 'absent'" };
      }
      // verification-check-must-not-demand-a-name-the-builder-has-to-guess Phase 1 — reject a bare
      // literal that pins a name the builder invents unless the spec body pins it. Fires only when
      // `specText` is provided (author-time chokepoint); the runner path passes no specText and
      // therefore never retroactively fails an already-authored check on this basis (defense-in-depth
      // lives at authoring, where a rejection is actionable).
      if (typeof ctx?.specText === "string") {
        const guess = detectBuilderChosenNameInGrep(pattern, ctx.specText);
        if (guess) {
          return { valid: false, reason: `${guess.reason}. Try grep.pattern: ${guess.suggested}` };
        }
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
      if (!isRecord(params)) {
        return { valid: false, reason: "db_probe_readonly requires { probe_id, expect }" };
      }
      const { probe_id, args } = params as Record<string, unknown>;
      if (typeof probe_id !== "string" || !probe_id.trim()) {
        return {
          valid: false,
          reason: "db_probe_readonly.probe_id must be a non-empty string naming a registered probe",
        };
      }
      // Registered-probe gate — a spec-authored probe_id must resolve in the DB_PROBES allowlist,
      // otherwise no fixed SQL template exists and nothing may run. Closes the injection /
      // unsafe_admin_client class at authoring time.
      if (!isRegisteredProbe(probe_id)) {
        return {
          valid: false,
          reason:
            `db_probe_readonly.probe_id '${probe_id}' is not a registered probe ` +
            `(allowlist: [${listRegisteredProbes().join(", ")}] in src/lib/spec-check-db-probes.ts)`,
        };
      }
      // args are scalar-only + arg names must not look like a secret column name — belt-and-suspenders
      // even though the probe binds them via .eq() (not a template splice).
      let argsRecord: Record<string, unknown> = {};
      if (args !== undefined) {
        if (!isRecord(args)) {
          return {
            valid: false,
            reason: "db_probe_readonly.args (if set) must be an object of {name: string|number|boolean}",
          };
        }
        argsRecord = args as Record<string, unknown>;
        for (const [k, v] of Object.entries(argsRecord)) {
          if (containsSensitiveColumn(k)) {
            return {
              valid: false,
              reason: `db_probe_readonly.args.${k} names a sensitive column (denied by the encrypted/secret denylist)`,
            };
          }
          if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
            return {
              valid: false,
              reason: `db_probe_readonly.args.${k} must be string | number | boolean (got ${typeof v})`,
            };
          }
        }
      }
      // Required args must all be present.
      const def = DB_PROBES[probe_id];
      const missing = def.requiredArgs.filter((k) => !(k in argsRecord));
      if (missing.length) {
        return {
          valid: false,
          reason: `db_probe_readonly.args missing required arg(s) for probe '${probe_id}': [${missing.join(", ")}]`,
        };
      }
      if (!("expect" in (params as Record<string, unknown>))) {
        return { valid: false, reason: "db_probe_readonly.expect is required (may be null)" };
      }
      const expect = (params as Record<string, unknown>).expect;
      if (
        expect !== null &&
        typeof expect !== "number" &&
        typeof expect !== "boolean"
      ) {
        return {
          valid: false,
          reason: "db_probe_readonly.expect must be null | number | boolean (probes return a scalar)",
        };
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
