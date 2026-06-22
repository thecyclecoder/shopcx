"use client";

/**
 * "🔍 Escalated → AI Investigation" — the visible label for a ticket escalated to the AI Routine
 * (escalated_at set + escalated_to IS NULL). That NULL state means the hourly solver→skeptic→quorum
 * sweep (box-escalation-triage) owns the ticket; this badge tells a human agent it's being
 * investigated by the routine (so they can wait/coordinate) while making clear they can still step in
 * by escalating it to a person. Amber/escalation styling. Renders nothing for a human escalation
 * (escalated_to set) or a non-escalated ticket — so it supersedes the plainer "AI Routine" wording
 * only for the escalated_to-IS-NULL case.
 *
 * `triageInProgress` (a triage-escalations job in-flight for the workspace) appends "· triage in
 * progress" — see useTriageInProgress / GET /api/tickets/triage-status. See
 * docs/brain/specs/ai-investigation-ticket-visibility.md.
 */
export function AiInvestigationBadge({
  escalatedAt,
  escalatedTo,
  triageInProgress,
  compact,
  className,
}: {
  escalatedAt?: string | null;
  escalatedTo?: string | null;
  triageInProgress?: boolean;
  /** Drop the "Escalated → " prefix (e.g. inside an Escalated/Routed-to column where it's redundant). */
  compact?: boolean;
  className?: string;
}) {
  // AI-Investigation state only: escalated to the routine, not a human.
  if (!escalatedAt || escalatedTo) return null;
  return (
    <span
      title="Escalated to the AI Routine — solver→skeptic→quorum investigation. A human can still take it by escalating it to a person."
      className={`inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 ${className || ""}`}
    >
      🔍 {compact ? "AI Investigation" : "Escalated → AI Investigation"}
      {triageInProgress ? " · triage in progress" : ""}
    </span>
  );
}
