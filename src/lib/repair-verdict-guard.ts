/**
 * Repair-lane verdict guard — shared pure helpers for the "transient" disposition of the
 * Control Tower repair lane (scripts/builder-worker.ts `runRepairJob`).
 *
 * SPEC: docs/brain/specs/repair-transient-park-verifies-itself.md Phase 1 + Phase 2.
 *
 * ## Why this exists
 *
 * A `"transient"` repair verdict whose *reason* cites an unverified pending fix (queued build,
 * pending deploy, resolved-by, auto-queued, an in-flight fix, or a `[[spec-slug]]` link) is a
 * hypothesis, not a resolution — closing on it phantom-closes the loop before the deploy lands
 * and the metric recovers. The repair lane holds that line in CODE (not just the prompt) via
 * `citesUnverifiedFix`, so a slipped LLM verdict cannot silently close.
 *
 * ## The `in-flight` false-positive this narrows
 *
 * The original inline regex matched the bare word `in-flight` ANYWHERE in the reason. Deploy-storm
 * diagnoses legitimately say things like "a deploy reaped in-flight Inngest runs" — a description
 * of what happened to the CRON, not a citation of a pending fix. Those correct `transient` verdicts
 * got mis-parked as "pending verification — unverified fix cited", escalated to the CEO inbox, and
 * never cleared (the three Sep 18 deploy-storm parks: deploy-guardian-cron, meta-capi-dispatch-cron,
 * amplifier-import-reconcile — 25 days as Park Backstop cards).
 *
 * So `in-flight` only counts as a fix citation when it is attached to a fix noun —
 * `fix in-flight`, or `in-flight build|spec|PR|deploy|fix` — never `in-flight Inngest runs/ticks/
 * functions`. Covered by src/lib/repair-verdict-guard.test.ts.
 *
 * `citesUnverifiedFix` is pure (no DB / network / clock) — safe to import anywhere and unit-test
 * directly. `isLoopRecoveredSince` (Phase 2) takes a Supabase admin client and reads
 * `loop_heartbeats`; its recovery predicate (`beatsAreRecovered`) is factored out as a pure
 * function so it can be unit-tested against fixture beats with no DB.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The cited-unverified-fix signal. Returns true when a `"transient"` reason references a fix that
 * has NOT yet been verified in production — meaning the repair lane must PARK (pending verification),
 * not close.
 *
 * Triggers (unchanged from the original inline regex, except the narrowed in-flight clause):
 *   - `pending deploy`, `pending verification`
 *   - `already-fixed`, `resolved-by`, `auto-queued`, `queued build`
 *   - a fix-attached `in-flight` — `fix in-flight`, or `in-flight build|spec|PR|deploy|fix`
 *     (a BARE `in-flight`, as in "reaps in-flight Inngest cron ticks", does NOT match)
 *   - a `[[spec-slug]]` wiki link (an authored fix spec)
 */
export function citesUnverifiedFix(reason: string): boolean {
  return UNVERIFIED_FIX_RE.test(reason);
}

const UNVERIFIED_FIX_RE =
  /(pending\s+deploy|pending\s+verification|already[-\s]?fixed|resolved[-\s]?by|auto[-\s]?queued|fix(?:\s+\w+){0,2}\s+in[-\s]?flight|in[-\s]?flight\s+(?:build|spec|pr|deploy|fix)|queued\s+build|\[\[[a-z0-9-]+\]\])/i;

/** One `loop_heartbeats` row, pared to the fields the recovery predicate needs. */
export interface LoopBeat {
  ran_at: string;
  ok: boolean;
}

/**
 * Pure recovery predicate over the `loop_heartbeats` rows emitted AFTER an alert anchor.
 *
 * Recovered ⇔ there are at least `minOkBeats` healthy (`ok=true`) beats since the anchor AND no
 * failed beat (`ok=false`) landed after the most-recent healthy beat — i.e. the loop is CURRENTLY
 * green and has stayed green for enough beats to trust it, not mid-flap. An empty window (the loop
 * never ran since the alert) is NOT recovered — absence of beats is not evidence of health.
 *
 * `beats` may be in any order; this sorts a copy by `ran_at`. Factored out of the DB call so it can
 * be unit-tested against fixtures.
 */
export function beatsAreRecovered(beats: LoopBeat[], minOkBeats = 2): boolean {
  const okBeats = beats.filter((b) => b.ok);
  if (okBeats.length < minOkBeats) return false;
  // The latest healthy beat's timestamp — a later failed beat means the loop went red again.
  const latestOkRanAt = okBeats.reduce((max, b) => (b.ran_at > max ? b.ran_at : max), "");
  const failedAfterLatestOk = beats.some((b) => !b.ok && b.ran_at > latestOkRanAt);
  return !failedAfterLatestOk;
}

/**
 * True when the monitored loop `loopId` has recovered since `sinceIso` — enough fresh healthy
 * beats, with no fail after the latest ok (see `beatsAreRecovered`). This is the machine-checkable
 * recovery signal a parked loop-alert repair uses to CLOSE itself instead of waiting on a human.
 *
 * Reads `loop_heartbeats` for `loop_id = loopId` with `ran_at > sinceIso`. Fail-safe: on a DB error
 * (or no rows) it returns `false` — a repair stays parked rather than closing on a read that failed.
 */
export async function isLoopRecoveredSince(
  admin: Admin,
  loopId: string,
  sinceIso: string,
  minOkBeats = 2,
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("loop_heartbeats")
      .select("ran_at, ok")
      .eq("loop_id", loopId)
      .gt("ran_at", sinceIso)
      .order("ran_at", { ascending: true })
      .limit(200);
    if (error) {
      console.warn(`[repair-verdict-guard] isLoopRecoveredSince read failed for ${loopId}: ${error.message}`);
      return false;
    }
    return beatsAreRecovered((data ?? []) as LoopBeat[], minOkBeats);
  } catch (e) {
    console.warn(`[repair-verdict-guard] isLoopRecoveredSince threw for ${loopId}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** Strip the `loop:` prefix off a repair signature (`loop:<id>` → `<id>`); null if not a loop signature. */
export function loopIdFromSignature(signature: string | null | undefined): string | null {
  if (typeof signature !== "string") return null;
  const m = signature.match(/^loop:(.+)$/);
  return m ? m[1] : null;
}
