/**
 * box-failed-build-supersede-and-dismiss Phase 1 — per-slug "latest build attempt" selector for the
 * failed-builds callout on /dashboard/roadmap/box.
 *
 * The old GET /api/roadmap/box logic sorted build/plan agent_jobs `created_at DESC` and kept the
 * first row per slug, then flagged it "failed" if that row's status was `failed`. That masked the
 * real case seen 2026-07-02 for `box-self-update-persist-skip-reason`: a long build that STARTED
 * earlier and MERGED later (06:09 → 08:50) was superseded on the card by a quick failed attempt
 * created in between (08:41), because raw recency preferred the failure over the actual success.
 *
 * Fix: rank by OUTCOME precedence (merged/completed > in-flight > failed), and only use recency
 * as a tiebreaker within the same tier. If any sibling for the slug is a terminal success, that
 * success is the surface state — no card, regardless of a later failed row.
 */

export type BuildAttempt = {
  id: string;
  spec_slug: string;
  status: string;
  created_at: string;
};

const BUILD_OUTCOME_PRECEDENCE: Record<string, number> = {
  merged: 3,
  completed: 3,
  building: 2,
  queued: 2,
  queued_resume: 2,
  needs_input: 2,
  needs_approval: 2,
  failed: 1,
};

export function outcomeRank(status: string): number {
  return BUILD_OUTCOME_PRECEDENCE[status] ?? 0;
}

/**
 * Given a batch of build/plan attempts (any input order), return one winner per spec_slug ranked
 * by outcome precedence first and by created_at recency on tie. A terminal-success sibling always
 * wins over a later failed attempt.
 */
export function selectLatestBuildBySlug<T extends BuildAttempt>(
  attempts: readonly T[]
): Map<string, T> {
  const winners = new Map<string, T>();
  for (const j of attempts) {
    const existing = winners.get(j.spec_slug);
    if (!existing) {
      winners.set(j.spec_slug, j);
      continue;
    }
    const jr = outcomeRank(j.status);
    const er = outcomeRank(existing.status);
    if (jr > er) {
      winners.set(j.spec_slug, j);
      continue;
    }
    if (jr === er && j.created_at > existing.created_at) {
      winners.set(j.spec_slug, j);
    }
  }
  return winners;
}
