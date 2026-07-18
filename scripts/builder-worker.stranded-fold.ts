/**
 * fold-never-strands-a-shipped-spec-with-a-zero-machine-check-spec-test Phase 1 — the pure
 * decision predicate for the fold-queue reaper's stranded-fold backstop. Kept in its own tiny
 * module so [[../scripts/builder-worker.stranded-fold.test.ts]] can import it without dragging in
 * builder-worker.ts's top-level `main()` (which requires GITHUB_TOKEN).
 *
 * Called from [[../scripts/builder-worker.ts]] `sweepStrandedFolds` — the periodic reaper's
 * (C) pass that recovers a derived-shipped spec never enqueued into `pending_folds` (the
 * primary auto-fold sweep drops a clean 0-machine-check run via the
 * [[../src/lib/spec-test-runs]] `isCleanMachinePassRun` checks-length floor).
 */

/**
 * Returns true iff a derived-shipped spec `slug` is genuinely STRANDED outside `pending_folds`
 * and should be enqueued via `enqueue_fold`. The five gates each mirror an invariant the primary
 * auto-fold sweep already enforces:
 *
 *   - `alreadyQueued` — a `pending`/`folding` row exists → the primary drainer owns it. Skip.
 *   - `foldedSlugs`   — a lingering `folded` row (fold completed but the row hasn't been GC'd)
 *                       → nothing to enqueue. Skip.
 *   - `liveSlugs`     — a live `build`/`spec-test` job exists → auto-fold would orphan the
 *                       running build ([[../src/lib/spec-test-runs]] `getAutoFoldEligibleSlugs`
 *                       fold-guard-live-build guard). Defer.
 *   - `mergedBuildSlugs` — no `agent_jobs.kind='build'` `status='merged'` row → the code hasn't
 *                       actually landed on main yet. Skip.
 *   - `securityClean` — [[../src/lib/security-agent]] `getSecurityStateBySlug`.completedClean is
 *                       FALSE → post-merge security review missing/live/surfaced. Defer.
 *
 * DELIBERATELY OMITS the [[../src/lib/spec-test-runs]] `isCleanMachinePassRun` checks-length
 * floor — the whole point of this backstop is to recover the 0-check strand (a spec whose
 * Verification defines zero machine-runnable checks lands a clean 0-check run, which the pass
 * side accepts but the fold side rejects, leaving it stranded forever). A merged build + clean
 * security + all-shipped phases is stronger evidence than any spec-test signal, so the
 * checks-floor is redundant here.
 *
 * Pure — no I/O.
 */
export function isStrandedFoldCandidate(args: {
  slug: string;
  alreadyQueued: ReadonlySet<string>;
  foldedSlugs: ReadonlySet<string>;
  liveSlugs: ReadonlySet<string>;
  mergedBuildSlugs: ReadonlySet<string>;
  securityClean: boolean;
}): boolean {
  if (args.alreadyQueued.has(args.slug)) return false;
  if (args.foldedSlugs.has(args.slug)) return false;
  if (args.liveSlugs.has(args.slug)) return false;
  if (!args.mergedBuildSlugs.has(args.slug)) return false;
  if (!args.securityClean) return false;
  return true;
}
