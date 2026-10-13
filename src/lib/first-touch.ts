import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Pure predicate for the Sol first-touch dispatch (§ 3.95 of
 * src/lib/inngest/unified-ticket-handler.ts).
 *
 * Phase 1 of docs/brain/specs/playbooks-survive-merge-guard-teasers-watchdog-catches-stalls.md.
 * Extracted so the exact routing invariant the handler runs on is unit-testable (first-touch.test.ts).
 *
 * The `inheritedActivePlaybook` clause is the Phase-1 addition: auto-merge can bring a running
 * playbook into a ticket the handler still treats as a first touch (is_new_ticket). When it
 * does, the turn must take the § 3b playbook-continuation path, NOT a fresh Sol session — so a
 * new ticket that inherited a playbook never dispatches first touch.
 */
export interface SolFirstTouchInput {
  isNew: boolean;
  solFirstTouchEnabled: boolean;
  agentAssigned: boolean;
  msgType: "account" | "general" | "outreach";
  inheritedActivePlaybook: boolean;
}

export function shouldDispatchSolFirstTouch(input: SolFirstTouchInput): boolean {
  return (
    input.isNew &&
    input.solFirstTouchEnabled &&
    !input.agentAssigned &&
    input.msgType !== "outreach" &&
    !input.inheritedActivePlaybook
  );
}

/**
 * Mark a ticket as "touched" on its first outbound external message.
 * Adds "touched" + "ft:{source}" tags. No-op if already touched.
 */
export async function markFirstTouch(
  ticketId: string,
  source: "ai" | "workflow" | "journey" | "agent",
): Promise<void> {
  const admin = createAdminClient();

  const { data: ticket } = await admin
    .from("tickets")
    .select("tags")
    .eq("id", ticketId)
    .single();

  if (!ticket) return;

  const tags = (ticket.tags as string[]) || [];
  if (tags.includes("touched")) return; // Already touched

  const newTags = [...new Set([...tags, "touched", `ft:${source}`])];
  await admin.from("tickets").update({ tags: newTags }).eq("id", ticketId);
}
