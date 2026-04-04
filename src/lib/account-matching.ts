/**
 * Account Matching — single source of truth for finding potential linked accounts.
 * Used by: unified ticket handler (detection), journey step builder (building steps),
 * and any future account linking logic.
 */

import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface PotentialMatch {
  id: string;
  email: string;
}

/**
 * Find potential unlinked account matches for a customer.
 * Matches by: first_name + last_name, phone, or email local part.
 * Excludes already-linked accounts and previously rejected matches.
 *
 * @returns Array of unlinked, non-rejected potential matches. Empty = no linking needed.
 */
export async function findUnlinkedMatches(
  workspaceId: string,
  customerId: string,
  adminClient?: Admin,
): Promise<PotentialMatch[]> {
  const admin = adminClient || createAdminClient();

  const { data: customer } = await admin.from("customers")
    .select("id, email, phone, first_name, last_name")
    .eq("id", customerId).single();

  if (!customer) return [];

  // Build match conditions: name, phone, email prefix
  const conditions: string[] = [];
  if (customer.first_name && customer.last_name) {
    conditions.push(`and(first_name.eq.${customer.first_name},last_name.eq.${customer.last_name})`);
  }
  if (customer.phone) conditions.push(`phone.eq.${customer.phone}`);
  const emailLocal = customer.email?.split("@")[0];
  if (emailLocal) conditions.push(`email.ilike.${emailLocal}@%`);

  if (!conditions.length) return [];

  // Find potential matches
  const { data: potentialMatches } = await admin.from("customers")
    .select("id, email")
    .eq("workspace_id", workspaceId)
    .neq("id", customerId)
    .neq("email", customer.email)
    .or(conditions.join(","))
    .limit(10);

  if (!potentialMatches?.length) return [];

  // Exclude already-linked accounts
  const { data: existingLinks } = await admin.from("customer_links")
    .select("customer_id")
    .in("customer_id", potentialMatches.map(m => m.id));
  const linkedIds = new Set((existingLinks || []).map(l => l.customer_id));

  // Exclude previously rejected matches
  const { data: rejections } = await admin.from("customer_link_rejections")
    .select("rejected_customer_id")
    .eq("customer_id", customerId);
  const rejectedIds = new Set((rejections || []).map(r => r.rejected_customer_id));

  return potentialMatches.filter(m => !linkedIds.has(m.id) && !rejectedIds.has(m.id));
}
