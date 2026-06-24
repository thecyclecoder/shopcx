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

  // Find potential matches. A single mixed `.or(and(first_name,last_name),phone,email.ilike)`
  // forced a Seq Scan of the whole customers table (620k rows): the case-insensitive email
  // ILIKE branch is non-indexable on a plain btree, and the OR defeats the workspace_id index.
  // Under concurrent portal-bootstrap / sonnet / journey-builder load those scans saturated the
  // pool → PostgREST 500 (signature supabase-logs:b5db594131381078). Instead run one query per
  // branch so each is a Bitmap Index Scan on its own index (idx_customers_name_match,
  // idx_customers_phone, idx_customers_email_trgm), then merge + dedupe in memory.
  const baseFilter = () => admin.from("customers")
    .select("id, email")
    .eq("workspace_id", workspaceId)
    .neq("id", customerId)
    .neq("email", customer.email)
    .limit(10);

  const branches: PromiseLike<{ data: PotentialMatch[] | null }>[] = [];
  if (customer.first_name && customer.last_name) {
    branches.push(baseFilter().eq("first_name", customer.first_name).eq("last_name", customer.last_name));
  }
  if (customer.phone) branches.push(baseFilter().eq("phone", customer.phone));
  const emailLocal = customer.email?.split("@")[0];
  if (emailLocal) branches.push(baseFilter().ilike("email", `${emailLocal}@%`));

  if (!branches.length) return [];

  // Merge branch results, dedupe by id, cap at 10 to preserve the original limit.
  const byId = new Map<string, PotentialMatch>();
  for (const { data } of await Promise.all(branches)) {
    for (const row of data || []) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  const potentialMatches = Array.from(byId.values()).slice(0, 10);

  if (!potentialMatches.length) return [];

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
