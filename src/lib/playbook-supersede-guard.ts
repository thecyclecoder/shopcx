/**
 * playbook-supersede-guard — Pure predicate for "should the active playbook be cleared before
 * the next inbound turn runs?" Extracted from src/lib/inngest/unified-ticket-handler.ts so a unit
 * test can pin every widening (agent reply, CS-director resolution) and the handler stays a thin
 * two-query DB read + a single call to this helper.
 *
 * Why this exists (Melissa/eca3f43b, docs/brain/specs/post-resolution-inbound-reroute-and-silent-
 * turn-guard.md Phase 1): the original guard only fired on an EXTERNAL human-agent reply. June
 * (the CS Director) resolves a ticket as AI — approve_remedy + close + de-escalate — so her
 * resolution slipped past the guard, the ticket's stale pre-escalation refund playbook stayed
 * active, and a later customer follow-up (a "thanks — anything else?" or a "still no refund")
 * wrongly re-ran that playbook. The playbook found nothing to do, silently failed a cancel, and
 * sent the customer NOTHING back. Widening the guard to also treat a June resolution as a
 * supersede sends the follow-up back to Sol/Sonnet first-touch (remedy-aware) instead of a stale
 * pre-escalation lane.
 *
 * The runner's write-site (scripts/builder-worker.ts runCsDirectorCallJob) is the primary clearing
 * path — the CS-director transition patch nulls `active_playbook_id` (+ playbook_step +
 * playbook_exceptions_used) as part of the close_and_deescalate / deescalate_only patch, so the
 * handler almost never sees an "active_playbook_id + [CS Director review] note" pair. This helper
 * is the belt-and-suspenders safety net for the case where a director-resolution write reached the
 * ticket via a path that did NOT clear the playbook (a hand-written SDK call, a partial-failure
 * transition patch, a legacy row) — the handler still short-circuits the resume.
 */

/** One outbound ticket_messages row shape we care about for the predicate. */
export interface PlaybookSupersedeInputs {
  /** Does any EXTERNAL outbound `author_type='agent'` message exist on this ticket? */
  hasExternalAgentReply: boolean;
  /** Does any INTERNAL outbound `author_type='system'` message body start with `[CS Director review]`? */
  hasCsDirectorResolutionNote: boolean;
}

/** Why the playbook was superseded — surfaces on the `[System] Active playbook cleared …` sysNote. */
export type PlaybookSupersedeReason = "agent_reply" | "director_resolution";

/**
 * Pure predicate. Returns the reason a playbook should be superseded (cleared before the next
 * turn runs), or null when neither signal is present. Human agent reply outranks a director
 * resolution because a human reply is a stronger signal that the conversation has moved out of
 * the AI's hands entirely — the sysNote wording is more accurate.
 */
export function detectPlaybookSuperseder(
  inputs: PlaybookSupersedeInputs,
): PlaybookSupersedeReason | null {
  if (inputs.hasExternalAgentReply) return "agent_reply";
  if (inputs.hasCsDirectorResolutionNote) return "director_resolution";
  return null;
}

/**
 * Phase 3 of playbook-takeover-replies-and-clears-escalation — does a CS-Director verdict note
 * actually supersede the CURRENT playbook? Only when it was written AFTER the playbook started.
 *
 * `newestDirectorNoteAt` is the `created_at` of the MOST RECENT `[CS Director review]` note on the
 * ticket (null when there is none); `playbookStartedAt` is `playbook_context.playbook_started_at`
 * stamped by `startPlaybook`. A note strictly newer than the start is June's CURRENT verdict and
 * supersedes; a note that arrived through a MERGE and pre-dates the start does NOT (that was the
 * Juliana 22be5796 bug — the inherited playbook got cleared by an older merged verdict and
 * restarted from the top). When `playbookStartedAt` is null (legacy playbooks started before this
 * shipped) ANY director note counts, preserving the prior belt-and-suspenders behavior.
 *
 * Comparing the NEWEST note's timestamp is equivalent to "does any note after the start exist?":
 * if the newest is after the start a qualifying note exists; if the newest is before it, none do.
 */
export function csDirectorNoteSupersedesPlaybook(
  newestDirectorNoteAt: string | null | undefined,
  playbookStartedAt: string | null | undefined,
): boolean {
  if (!newestDirectorNoteAt) return false; // no director note at all → nothing to supersede
  if (!playbookStartedAt) return true; // legacy row with no start stamp → any note counts
  const noteMs = Date.parse(newestDirectorNoteAt);
  const startMs = Date.parse(playbookStartedAt);
  if (!Number.isFinite(noteMs) || !Number.isFinite(startMs)) return true; // unparseable → fail-safe to prior behavior
  return noteMs > startMs;
}

/**
 * Reason phrase that renders inside the `[System] Active playbook cleared — <phrase>, so the
 * playbook is no longer authoritative. Routing to Sol/Sonnet.` internal note. Kept beside the
 * predicate so a test can pin the sysNote wording per reason.
 */
export function playbookSupersedeReasonPhrase(reason: PlaybookSupersedeReason): string {
  switch (reason) {
    case "agent_reply":
      return "a human agent has replied externally on this ticket";
    case "director_resolution":
      return "the CS Director has resolved this ticket";
  }
}

/**
 * The exact `body` prefix a CS-Director verdict note starts with (see
 * `src/lib/cs-director-verdict-note.ts` `buildCsDirectorVerdictNote`). Exported so callers
 * (`src/lib/inngest/unified-ticket-handler.ts`) can ilike-match on the same prefix and a test
 * can pin the coupling.
 */
export const CS_DIRECTOR_VERDICT_NOTE_PREFIX = "[CS Director review]";
