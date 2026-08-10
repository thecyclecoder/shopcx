/**
 * cs-director-author-spec-failure-card — Pure builder for the CEO inbox card that
 * `runCsDirectorCallJob` (scripts/builder-worker.ts) mints when June (the CS Director)'s
 * `decision='author_spec'` verdict FAILED to write a spec — the `handleAuthorSpec` executor
 * returned `needs_attention:true` on any of its failure branches (`spec_seed_missing_*`,
 * `ticket_id_unresolved`, `author_spec_write_returned_false`, `author_spec_threw`, `handler_threw`).
 *
 * Before this shipped (june-authored-specs-carry-machine-runnable-checks Phase 2), a failed
 * author_spec parked the agent job `needs_attention` — the DESIGNED fail-safe — but no human ever
 * saw it: the ticket was left open, de-escalated, and OWNED BY NOBODY (Yvonne Carreon's ticket sat
 * that way for 2.6 days with her request already correctly fulfilled, and surfaced only because
 * the founder worked the queue by hand). A fail-safe nobody can see is not a fail-safe. Phase 1
 * removed today's cause (buildAuthorSpecInput now emits typed machine-runnable checks so the
 * SDK's chokepoint stops throwing MissingMachineCheckError on every call); THIS card makes the
 * NEXT unexpected author-spec failure visible to the founder immediately instead of silent.
 *
 * Shape: the same `dashboard_notifications` `agent_approval_request` surface every other
 * escalate-founder card uses (`buildEscalateFounderCard` in [[cs-director-escalate-founder-card]],
 * author-spec.ts:979 runaway-authoring, spec-drift.ts:1401 reverse-drift, fleet-spend-governor.ts
 * spend breach). `buildApprovalsFeed` (src/lib/agents/approvals-feed.ts) reads exactly this shape
 * into its escalated-set — a CEO reading the approvals feed sees the card in the same list as
 * every other approval, no separate surface to check.
 *
 * SINGLE-WRITER contract (mirrors `escalate_founder`): the RUNNER is the sole writer of this
 * card. `handleAuthorSpec` NEVER inserts a `dashboard_notifications` row — it returns
 * `needs_attention:true` with a machine-readable `reason` + `error` on the result, and the runner
 * mints the card AFTER `applyBoxCsDirectorCall` returns. This is the SAME single-writer principle
 * the escalate_founder path respects (see [[cs-director]] module header § "single-writer per
 * surface") — one deterministic writer per surface, so a duplicate card cannot page the CEO twice.
 *
 * Kept pure (no DB, no imports from the runtime worker) so the worker can call it + pass the row
 * shape to a straight `dashboard_notifications` insert, and a unit test can exercise every field
 * without a Supabase mock. Reads-only from the input — the caller is responsible for the write.
 *
 * See docs/brain/specs/cs-director-author-spec-emits-machine-runnable-checks.md § Phase 2 and
 * [[../../docs/brain/libraries/cs-director.md]] for the author_spec → CEO-card contract.
 */

export interface AuthorSpecFailureCardInput {
  /** The ticket that June ruled `author_spec` on — the card body links back to it. */
  ticketId: string;
  /** June's 2-4 sentence "why" for the spec (`reasoning` on the verdict) — carried on the card body. */
  reasoning: string;
  /** cs-director-call agent_jobs row that produced the verdict — links the card to the audit trail. */
  jobId: string;
  /** triage_runs row id when the call went through the triage audit slice (null when absent). */
  triageRunId?: string | null;
  /**
   * The machine-readable failure branch `handleAuthorSpec` returned (one of `spec_seed_missing_*`,
   * `ticket_id_unresolved`, `author_spec_write_returned_false`, `author_spec_threw`, `handler_threw`).
   * Persisted on metadata + rendered in the body so the founder sees WHICH class failed at a glance.
   */
  failureReason: string;
  /**
   * Optional human-readable error string (the `error` field on `ApplyBoxCsDirectorCallResult`),
   * carried verbatim on the body when present so the founder sees the concrete diagnosis
   * (e.g. "author_spec: SDK threw (…)"). Null-safe.
   */
  failureError?: string | null;
  /**
   * The `spec_seed` June named on the verdict — an object shape carrying `slug`/`title`/`intent`/
   * `problem`/`target?`. Rendered on the body as "Intended spec: {slug} — {title}" so the founder
   * sees the diagnosis that would otherwise be lost, and can author it by hand if needed. Null when
   * the seed was missing/malformed on the verdict itself.
   */
  specSeed?: Record<string, unknown> | null;
}

export interface AuthorSpecFailureCardRow {
  title: string;
  body: string;
  link: string;
  metadata: {
    routed_to_function: "ceo";
    raised_by_function: "cs";
    escalated_by_director: "cs";
    escalation_kind: "cs_director_author_spec_failed";
    /** buildApprovalsFeed reads this as the card summary — carries the failure reason + June's reasoning (trimmed). */
    escalation_reason: string;
    ticket_id: string;
    cs_director_call_job_id: string;
    triage_run_id: string | null;
    deep_link: string;
    autonomous: boolean;
    /** so the approvals-feed enrichment can join to the cs-director-call agent_jobs row. */
    agent_job_id: string;
    /** the concrete failure branch from `handleAuthorSpec` — machine-readable for downstream handlers. */
    failure_reason: string;
    /** the human-readable error line, verbatim from `handleAuthorSpec` when it set one. Null-safe. */
    failure_error: string | null;
    /**
     * The `spec_seed` from June's verdict, verbatim, so a downstream approver / bounce-back handler
     * can pick it up without re-parsing the human body. Null when the seed itself was missing.
     */
    spec_seed: Record<string, unknown> | null;
  };
}

function normalizeReasoning(raw: string): string {
  const s = (raw || "").trim();
  return s.length > 0 ? s : "(no reasoning recorded)";
}

function pickString(source: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!source) return null;
  const v = source[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Render June's intended spec as a one-line "Intended spec: {slug} — {title}" summary. Mirrors
 * the summarize-* patterns in [[cs-director-escalate-founder-card]] so the CEO surface reads the
 * same across escalation paths. When both slug + title are absent (or the seed itself was missing)
 * the fallback names the seed as absent — never a bare "spec unknown" (the founder should always
 * see what they can act on).
 */
export function summarizeIntendedSpec(seed: Record<string, unknown> | null | undefined): string {
  if (!seed) return "(none — the spec_seed itself was missing/malformed on the verdict)";
  const slug = pickString(seed, "slug");
  const title = pickString(seed, "title");
  if (slug && title) return `${slug} — ${title}`;
  if (slug) return slug;
  if (title) return title;
  return "(none — the spec_seed carried no slug/title)";
}

/**
 * Pure builder — returns the `dashboard_notifications` row shape (title/body/link/metadata) for the
 * CEO inbox card an author_spec FAILURE mints. Deterministic in its inputs — the same inputs
 * always yield the same title/body/metadata, so the test suite can exercise it end-to-end.
 *
 * Title is the human-facing chip in the approvals feed. Body carries a labeled "Intended spec:",
 * "Diagnosis:" (June's reasoning), and "Failure:" (the machine-readable branch + the human error
 * line when present) so the CEO can decide whether to author the spec by hand OR treat it as a
 * signal that the author path itself has a bug that needs a code fix. The deep-link takes them
 * to the ticket for full context.
 */
export function buildAuthorSpecFailureCard(input: AuthorSpecFailureCardInput): AuthorSpecFailureCardRow {
  const {
    ticketId,
    reasoning,
    jobId,
    triageRunId,
    failureReason,
    failureError,
    specSeed,
  } = input;
  const normalizedReason = normalizeReasoning(reasoning);
  const link = `/dashboard/tickets/${ticketId}`;

  const title = `CS Director — author_spec FAILED (needs founder review)`.slice(0, 200);

  const intendedLine = `Intended spec: ${summarizeIntendedSpec(specSeed)}`;
  const diagnosisLine = `Diagnosis: ${normalizedReason}`;
  const failureLine =
    failureError && failureError.trim().length > 0
      ? `Failure (${failureReason}): ${failureError.trim()}`
      : `Failure: ${failureReason}`;
  const body = [intendedLine, diagnosisLine, failureLine].join("\n").slice(0, 4000);

  // The seed persists on metadata verbatim so a downstream approver can pick it up without re-
  // parsing the body — null (not omitted) so the caller can distinguish "absent" from "unread".
  const seedMeta = specSeed && Object.keys(specSeed).length > 0 ? specSeed : null;

  return {
    title,
    body,
    link,
    metadata: {
      routed_to_function: "ceo",
      raised_by_function: "cs",
      escalated_by_director: "cs",
      escalation_kind: "cs_director_author_spec_failed",
      escalation_reason: `author_spec FAILED (${failureReason}): ${normalizedReason}`.slice(0, 2000),
      ticket_id: ticketId,
      cs_director_call_job_id: jobId,
      triage_run_id: triageRunId ?? null,
      deep_link: link,
      autonomous: true,
      agent_job_id: jobId,
      failure_reason: failureReason,
      failure_error: failureError && failureError.trim().length > 0 ? failureError.trim() : null,
      spec_seed: seedMeta,
    },
  };
}
