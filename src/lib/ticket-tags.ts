import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Tags that mark a ticket as low-value / not-actually-handled: spam bots,
 * marketing outreach replies (incl. OOF auto-replies to our blasts), and the
 * classifier's outreach bucket. Consumers short-circuit work that only makes
 * sense on tickets we genuinely engaged:
 *   - the ticket-analyzer ([[ticket-analyzer]]) skips grading them
 *   - the CSAT cron ([[inngest/ticket-csat]]) skips surveying them
 * One source of truth so the two consumers can't drift.
 */
export const SKIP_TAGS = new Set(["spam:bot", "outreach", "cls:outreach"]);

/**
 * Add a tag to a ticket if not already present. Idempotent.
 */
export async function addTicketTag(ticketId: string, tag: string): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("tickets").select("tags").eq("id", ticketId).single();
  if (!data) return;
  const tags = (data.tags as string[]) || [];
  if (tags.includes(tag)) return;
  await admin.from("tickets").update({ tags: [...tags, tag] }).eq("id", ticketId);
}
