/**
 * Resolve the 'Escalated To' target on a ticket to a persona shown in the UI.
 *
 * An "AI Routine" escalation (escalated_at set, escalated_to NULL) is not a faceless
 * routine — the box-escalation-triage solver→skeptic→quorum sweep runs first, and
 * any ticket the quorum can't call is hard-called by June, the CS Director
 * (docs/brain/specs/cs-director-third-rung-hard-calls-above-triage-quorum.md).
 * The 'Escalated To' field should surface June's identity, not a generic label.
 *
 * Human escalations (escalated_to set) surface the assignee's workspace_member
 * display_name at the call site — this helper returns null for that case.
 *
 * Pure config, no server imports; safe to call from client + server surfaces.
 */
import { PERSONAS, type AgentPersona } from "@/lib/agents/personas";

export function resolveEscalationPersona(
  escalatedAt: string | null | undefined,
  escalatedTo: string | null | undefined,
): AgentPersona | null {
  if (!escalatedAt) return null;
  if (escalatedTo) return null;
  return PERSONAS["cs-director"] ?? null;
}
