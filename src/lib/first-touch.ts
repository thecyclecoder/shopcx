import { createAdminClient } from "@/lib/supabase/admin";

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
