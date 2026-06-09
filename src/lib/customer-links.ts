import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * All customer UUIDs in the same link group (including self). Linked accounts are
 * one person, so anything "per person" — loyalty balance, the default payment
 * method, sub ownership — resolves across this set. Linking is display-only;
 * these are real, separate customer rows that happen to be the same human.
 */
export async function linkGroupIds(admin: Admin, workspaceId: string, customerId: string): Promise<string[]> {
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: peers } = await admin
    .from("customer_links")
    .select("customer_id")
    .eq("workspace_id", workspaceId)
    .eq("group_id", link.group_id);
  const ids = new Set<string>([customerId]);
  for (const p of peers || []) if (p.customer_id) ids.add(p.customer_id as string);
  return [...ids];
}
