/**
 * security-envelope — pure validator for the FUSED pre-merge security envelope
 * ([[../specs/fused-premerge-security-authoritative-drop-standalone]] Phase 1). The `runSpecTestJob`
 * fused session emits one JSON object combining the spec-test verdict AND a security envelope; that
 * envelope is what the M4 promote gate ends up trusting once Phase 2 makes it authoritative.
 *
 * The weakness Phase 1 closes: the earlier fused envelope carried a bare `security.status = "clean"`
 * flag the session declared itself, which a rubber-stamp could satisfy end-to-end without ever
 * reviewing anything (isolate-premerge-security-verdict distrusted that exactly). Fix by requiring
 * the envelope to be STRUCTURED and EVIDENCE-BACKED — per-check entries `{check, verdict, evidence}`
 * where `clean` MUST cite what was inspected and `finding` MUST carry file:line + severity. This
 * validator classifies the envelope; a bare/evidence-less `clean` downgrades to `needs_human`
 * (advisory — NEVER an auto-clean gate pass), so a rubber-stamp can't satisfy the merge gate.
 *
 * Pure — no I/O, no DB, no imports of admin clients. Safe to import from either the box worker
 * (`scripts/builder-worker.ts`) or the Next runtime.
 */

/**
 * The five checklist items the fused prompt reviews for. These MUST match the FUSED PRE-MERGE
 * SECURITY REVIEW block in scripts/builder-worker.ts (the prompt lists them; this constant enforces
 * that the envelope covers every one). If a new check is added to the prompt, add its key here so
 * a `clean` envelope must cover it too.
 */
export const REQUIRED_SECURITY_CHECKS = [
  "injection",
  "secret_leak",
  "authz_rls",
  "unsafe_admin_client",
  "crypto_encrypted",
] as const;

export type SecurityCheckKey = typeof REQUIRED_SECURITY_CHECKS[number];

/** One structured per-check verdict the fused session emits. */
export interface SecurityCheckEntry {
  /** the checklist item this entry answers (one of REQUIRED_SECURITY_CHECKS). */
  check: string;
  /** the per-check verdict — clean (with evidence), finding (with file:line + severity), or needs_human. */
  verdict: "clean" | "finding" | "needs_human";
  /** for `clean`: what the session inspected (files/routes/tables it read, patterns it grepped).
   *  for `finding`: the finding narrative (the file:line + severity are structured on the entry).
   *  for `needs_human`: why the session cannot classify. Always required — the whole point of Phase 1. */
  evidence: string;
  /** finding-only: `file:line` reference (secrets by location only — never echo the value). */
  location?: string;
  /** finding-only: severity band (low / medium / high / critical). */
  severity?: string;
}

/** The shape the fused session emits under `security`. */
export interface FusedSecurityEnvelope {
  /** the session's declared overall status (advisory — the validator RE-DERIVES). */
  status?: string;
  /** the plain-text review (findings by file:line + category + severity + the fix). */
  review?: string;
  /** the structured per-check verdicts — Phase 1's new contract. */
  checks?: SecurityCheckEntry[];
  /** legacy shape: findings might have been emitted as a flat array. Validator treats them as findings. */
  findings?: unknown;
  /** the authored fix spec (only when the RE-DERIVED classification is `not-clean` + status="real-vuln"). */
  spec?: unknown;
}

/** The classification the validator returns — what the M4 gate should key off. */
export type SecurityEnvelopeClassification =
  /** every required checklist item is `clean` with evidence — a real clean verdict. Gate can pass. */
  | "clean"
  /** the envelope carried findings (or a `finding` entry) — the gate must block. */
  | "not-clean"
  /** the envelope is bare / evidence-less / partial / self-declared — advisory, gate holds for a human. */
  | "needs_human";

/** The validator's structured verdict — the classification plus WHY (for surfacing on the review row). */
export interface SecurityEnvelopeVerdict {
  classification: SecurityEnvelopeClassification;
  /** one-line reason (why this classification) — cite on the log_tail so the surfaced row is legible. */
  reason: string;
  /** per-required-check status (what the fused session claimed vs. whether it carried evidence). */
  perCheck: Array<{
    check: SecurityCheckKey;
    /** the entry's verdict as normalized (missing entry → "missing"). */
    verdict: "clean" | "finding" | "needs_human" | "missing";
    /** true iff `clean` AND the entry has a non-empty evidence string. */
    hasEvidence: boolean;
  }>;
  /** the count of `finding` entries the envelope carried (any → `not-clean`). */
  findingCount: number;
  /** true iff at least one `finding` was missing its required file:line location. */
  findingMissingLocation: boolean;
}

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * Classify a fused pre-merge security envelope into `clean` / `not-clean` / `needs_human`.
 * Pure. Never throws — a malformed envelope returns `needs_human` with a reason string.
 *
 * Rules (in order):
 *   1. envelope is null / not-an-object → `needs_human` (missing envelope).
 *   2. `checks` is not an array OR is empty → `needs_human` (bare, self-declared).
 *   3. Any `finding` entry (with file:line + severity) → `not-clean`.
 *      A `finding` missing its `location` (file:line) still counts as `not-clean` — it's a
 *      finding, not a clean pass — but flag `findingMissingLocation` so the surfaced row can note it.
 *   4. Any `needs_human` entry → `needs_human` (session couldn't classify a check).
 *   5. Every REQUIRED check present with verdict='clean' AND non-empty evidence → `clean`.
 *   6. Otherwise (missing a required check, or a `clean` without evidence) → `needs_human`.
 */
export function classifyFusedSecurityEnvelope(envelope: unknown): SecurityEnvelopeVerdict {
  const emptyPerCheck: SecurityEnvelopeVerdict["perCheck"] = REQUIRED_SECURITY_CHECKS.map((c) => ({
    check: c,
    verdict: "missing",
    hasEvidence: false,
  }));

  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return {
      classification: "needs_human",
      reason: "no security envelope on the fused spec-test result",
      perCheck: emptyPerCheck,
      findingCount: 0,
      findingMissingLocation: false,
    };
  }
  const env = envelope as FusedSecurityEnvelope;

  const rawChecks = env.checks;
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    return {
      classification: "needs_human",
      reason: "fused security envelope carried no structured `checks` array — bare/self-declared verdict cannot satisfy the pre-merge gate",
      perCheck: emptyPerCheck,
      findingCount: 0,
      findingMissingLocation: false,
    };
  }

  const perCheckMap = new Map<string, { verdict: "clean" | "finding" | "needs_human" | "missing"; hasEvidence: boolean }>();
  for (const key of REQUIRED_SECURITY_CHECKS) perCheckMap.set(key, { verdict: "missing", hasEvidence: false });

  let findingCount = 0;
  let findingMissingLocation = false;
  let sawNeedsHuman = false;

  for (const raw of rawChecks) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as SecurityCheckEntry;
    const key = String(e.check ?? "").trim();
    const verdict = String(e.verdict ?? "").trim() as SecurityCheckEntry["verdict"];
    const evidence = nonEmptyString(e.evidence) ? e.evidence.trim() : "";

    if (verdict === "finding") {
      findingCount++;
      if (!nonEmptyString(e.location)) findingMissingLocation = true;
    } else if (verdict === "needs_human") {
      sawNeedsHuman = true;
    }

    if ((REQUIRED_SECURITY_CHECKS as readonly string[]).includes(key)) {
      const prior = perCheckMap.get(key)!;
      // If we already saw a `finding` for this check, keep it — a later `clean` re-entry can't unshadow it.
      if (prior.verdict === "finding") continue;
      if (verdict === "finding" || verdict === "needs_human" || verdict === "clean") {
        perCheckMap.set(key, {
          verdict,
          hasEvidence: verdict === "clean" ? nonEmptyString(evidence) : perCheckMap.get(key)!.hasEvidence,
        });
      }
    }
  }

  const perCheck: SecurityEnvelopeVerdict["perCheck"] = REQUIRED_SECURITY_CHECKS.map((c) => {
    const v = perCheckMap.get(c)!;
    return { check: c, verdict: v.verdict, hasEvidence: v.hasEvidence };
  });

  // Legacy `findings` array (a flat, unstructured list) → treat as findings too. A finding is a finding
  // regardless of the container shape; the validator refuses to declare clean when any is present.
  if (Array.isArray(env.findings) && env.findings.length > 0) findingCount += env.findings.length;

  if (findingCount > 0) {
    return {
      classification: "not-clean",
      reason: `fused security envelope carried ${findingCount} finding(s)${findingMissingLocation ? " (at least one missing file:line location)" : ""}`,
      perCheck,
      findingCount,
      findingMissingLocation,
    };
  }

  if (sawNeedsHuman) {
    return {
      classification: "needs_human",
      reason: "fused security envelope carried a `needs_human` per-check entry — session could not classify a check",
      perCheck,
      findingCount,
      findingMissingLocation,
    };
  }

  const missingChecks = perCheck.filter((c) => c.verdict === "missing").map((c) => c.check);
  if (missingChecks.length > 0) {
    return {
      classification: "needs_human",
      reason: `fused security envelope missing required check(s): ${missingChecks.join(", ")} — partial coverage cannot satisfy the pre-merge gate`,
      perCheck,
      findingCount,
      findingMissingLocation,
    };
  }

  const cleanWithoutEvidence = perCheck.filter((c) => c.verdict === "clean" && !c.hasEvidence).map((c) => c.check);
  if (cleanWithoutEvidence.length > 0) {
    return {
      classification: "needs_human",
      reason: `fused security envelope declared \`clean\` without evidence for: ${cleanWithoutEvidence.join(", ")} — a bare/evidence-less clean is a rubber-stamp risk`,
      perCheck,
      findingCount,
      findingMissingLocation,
    };
  }

  return {
    classification: "clean",
    reason: `all ${REQUIRED_SECURITY_CHECKS.length} required checks marked clean with evidence`,
    perCheck,
    findingCount,
    findingMissingLocation,
  };
}
