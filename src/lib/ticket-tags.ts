import { createAdminClient } from "@/lib/supabase/admin";

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
