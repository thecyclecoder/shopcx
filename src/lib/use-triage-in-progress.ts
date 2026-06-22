"use client";

import { useEffect, useState } from "react";

/**
 * Whether a triage-escalations job is currently in-flight for the active workspace — used to append
 * "· triage in progress" to the AiInvestigationBadge. Reads GET /api/tickets/triage-status (which
 * resolves the workspace from the cookie). Fetched once on mount; the badge is informational, not a
 * live ticker. See docs/brain/specs/ai-investigation-ticket-visibility.md.
 */
export function useTriageInProgress(): boolean {
  const [inProgress, setInProgress] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/tickets/triage-status")
      .then((r) => (r.ok ? r.json() : { in_progress: false }))
      .then((d) => {
        if (active) setInProgress(!!d?.in_progress);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return inProgress;
}
