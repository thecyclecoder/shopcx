/**
 * Pre-orchestrator helper: scan a customer's recent inbound messages
 * for identifiers that point at a DIFFERENT customer profile in the
 * same workspace, and link them automatically before Sonnet runs.
 *
 * Two kinds of identifier are honored:
 *
 *  1. **Email address** — the motivating case (ticket 9f87b748):
 *     customer wrote in from email A complaining about charges and
 *     explicitly mentioned "my husband's email is B" in the same
 *     message. We link A↔B so get_customer_account returns the merged
 *     set and the orchestrator routes straight to the right journey.
 *
 *  2. **Order number** — ticket 23fe617c: customer wrote in from
 *     lovethosebuysllc@gmail.com asking to return order #SC132076, but
 *     that order actually belongs to kzcosmetiks@gmail.com (they
 *     misremembered which email they ordered under). The email they
 *     *guessed* had no profile, so link_account_by_email failed. The
 *     ORDER NUMBER is the authoritative key: we look up the email tied
 *     to that order (our orders table first, then Shopify for unsynced
 *     orders) and link the order's owner to the ticket customer.
 *
 * Linking before Sonnet runs lets the orchestrator's
 * get_customer_account tool return the merged customer data and route
 * to the right journey instead of asking an identity question the
 * customer already answered.
 *
 * Returns the number of new links made + a human-readable label per
 * link for logging. Never throws — auto-linking is best-effort, the
 * orchestrator runs regardless.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

interface AutoLinkResult {
  linkedCount: number;
  /** Human-readable labels, e.g. "kzcosmetiks@gmail.com (order SC132076)". */
  linkedEmails: string[];
}

/**
 * Conservative email regex — matches common email shapes without
 * trying to perfectly implement RFC 5322. Multiline-aware (some
 * inbound emails carry newlines mid-text).
 */
const EMAIL_REGEX = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;

/**
 * Order-number shapes. Two patterns, both validated against a real
 * order before any link is made (so over-matching is harmless — a
 * token that isn't a real order resolves to nothing):
 *   - Prefixed names like `SC132076` / `#SC132076` (this store's format).
 *   - Bare numeric ids, but ONLY in an explicit "order #…" context, to
 *     avoid matching phone numbers, zips, and dollar amounts.
 */
const ORDER_NAME_REGEX = /#?\b([A-Za-z]{1,5}\d{3,})\b/g;
const ORDER_NUMERIC_CONTEXT_REGEX = /order\s*(?:no\.?|number|#)?\s*#?\s*(\d{4,})\b/gi;
/** Cap Shopify lookups per run — junk-number protection. */
const MAX_ORDER_CANDIDATES = 5;

/**
 * Common addresses we'd never want to auto-link as a customer.
 * These show up in forwarded chains, headers, signatures.
 */
const IGNORED_EMAIL_DOMAINS = new Set([
  "updates.superfoodscompany.com",
  "superfoodscompany.com",
  "shopcx.ai",
  "klaviyo-mail.com",
  "klaviyomail.com",
  "shopify.com",
  "noreply",
  "no-reply",
]);

function extractCandidateEmails(text: string, primaryEmail: string): string[] {
  const matches = text.match(EMAIL_REGEX);
  if (!matches) return [];
  return Array.from(new Set(matches.map((m) => m.toLowerCase()))).filter((e) => {
    if (e === primaryEmail) return false;
    const domain = e.split("@")[1] || "";
    if (!domain) return false;
    for (const ignored of IGNORED_EMAIL_DOMAINS) {
      if (domain === ignored || domain.endsWith(`.${ignored}`) || e.startsWith(`${ignored}@`)) return false;
    }
    return true;
  });
}

function extractOrderNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ORDER_NAME_REGEX)) out.add(m[1].toUpperCase());
  for (const m of text.matchAll(ORDER_NUMERIC_CONTEXT_REGEX)) out.add(m[1]);
  return Array.from(out).slice(0, MAX_ORDER_CANDIDATES);
}

/**
 * Link two customer profiles into one group. Idempotent: a no-op when
 * they already share a group_id. Returns true only when a NEW link was
 * committed. The ticket's current customer is kept/seeded as primary.
 */
async function linkTwoCustomers(
  admin: SupabaseClient,
  workspaceId: string,
  ownerId: string,
  targetId: string,
): Promise<boolean> {
  if (ownerId === targetId) return false;

  const { data: ownerLink } = await admin
    .from("customer_links")
    .select("group_id, is_primary")
    .eq("customer_id", ownerId)
    .maybeSingle();
  const { data: targetLink } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", targetId)
    .maybeSingle();

  if (ownerLink && targetLink && ownerLink.group_id === targetLink.group_id) return false;

  const groupId = ownerLink?.group_id || targetLink?.group_id || crypto.randomUUID();
  if (!ownerLink) {
    await admin.from("customer_links").upsert(
      { customer_id: ownerId, workspace_id: workspaceId, group_id: groupId, is_primary: true },
      { onConflict: "customer_id" },
    );
  }
  await admin.from("customer_links").upsert(
    { customer_id: targetId, workspace_id: workspaceId, group_id: groupId, is_primary: false },
    { onConflict: "customer_id" },
  );
  return true;
}

/**
 * Resolve the customer profile that OWNS a given order number.
 *   1. Our orders table (synced orders) — order_number / name.
 *   2. Shopify fallback (unsynced orders) — look up the order by name,
 *      read its email + customer, then find OR create the local
 *      customer profile so we have a UUID to link.
 * Returns null when the order can't be found anywhere. Never throws.
 */
async function resolveOrderOwner(
  admin: SupabaseClient,
  workspaceId: string,
  orderNum: string,
): Promise<{ customerId: string; email: string | null } | null> {
  const clean = orderNum.replace(/^#/, "").trim();
  if (!clean) return null;

  try {
    // 1) Our orders table. order_number stores the Shopify order NAME
    // (e.g. "SC132076"); there is NO `name` column. Try an exact match
    // first; if the customer gave bare digits ("132076"), match the
    // prefixed name by suffix.
    const exact = await admin
      .from("orders")
      .select("customer_id, email")
      .eq("workspace_id", workspaceId)
      .eq("order_number", clean)
      .limit(1)
      .maybeSingle();
    let order = exact.data;
    if (!order?.customer_id && /^\d+$/.test(clean)) {
      const suffix = await admin
        .from("orders")
        .select("customer_id, email")
        .eq("workspace_id", workspaceId)
        .ilike("order_number", `%${clean}`)
        .limit(1)
        .maybeSingle();
      order = suffix.data;
    }
    if (order?.customer_id) {
      return { customerId: order.customer_id as string, email: (order.email as string) ?? null };
    }

    // 2) Shopify fallback — authoritative lookup of the order's email.
    const { getShopifyCredentials } = await import("@/lib/shopify-sync");
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($q: String!) {
          orders(first: 1, query: $q) {
            edges { node { name email customer { id email firstName lastName } } }
          }
        }`,
        variables: { q: `name:${clean}` },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const node = json?.data?.orders?.edges?.[0]?.node as
      | { name?: string; email?: string; customer?: { id?: string; email?: string; firstName?: string; lastName?: string } }
      | undefined;
    if (!node) return null;

    const email = (node.email || node.customer?.email || "").toLowerCase() || null;
    const shopifyCustomerId = node.customer?.id ? String(node.customer.id).split("/").pop() || null : null;

    // Find an existing local profile by shopify id, then by email.
    let local: { id: string; email: string | null } | null = null;
    if (shopifyCustomerId) {
      const { data } = await admin
        .from("customers")
        .select("id, email")
        .eq("workspace_id", workspaceId)
        .eq("shopify_customer_id", shopifyCustomerId)
        .maybeSingle();
      if (data) local = data as { id: string; email: string | null };
    }
    if (!local && email) {
      const { data } = await admin
        .from("customers")
        .select("id, email")
        .eq("workspace_id", workspaceId)
        .ilike("email", email)
        .maybeSingle();
      if (data) local = data as { id: string; email: string | null };
    }

    // No local profile yet (order's customer was never synced) — create
    // a minimal one so we have a UUID to link. Upsert keyed on the
    // Shopify id so a later full sync just enriches the same row.
    if (!local && shopifyCustomerId && email) {
      const { data: created } = await admin
        .from("customers")
        .upsert(
          {
            workspace_id: workspaceId,
            shopify_customer_id: shopifyCustomerId,
            email,
            first_name: node.customer?.firstName || null,
            last_name: node.customer?.lastName || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,shopify_customer_id" },
        )
        .select("id, email")
        .maybeSingle();
      if (created) local = created as { id: string; email: string | null };
    }

    if (local) return { customerId: local.id, email: local.email ?? email };
  } catch {
    // Best-effort — never block the orchestrator on a linking miss.
  }
  return null;
}

export async function autoLinkCustomerFromMessage(
  admin: SupabaseClient,
  workspaceId: string,
  ticketId: string,
  customerId: string,
): Promise<AutoLinkResult> {
  // Pull recent inbound external messages on this ticket. We scan more
  // than just the latest because the identifier (an order number, an
  // alternate email) is often given a turn or two before we act on it
  // — Katherine gave the order # in her opening message but the email
  // (which had no profile) only later.
  const { data: inbound } = await admin
    .from("ticket_messages")
    .select("body")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .eq("visibility", "external")
    .order("created_at", { ascending: false })
    .limit(10);

  const bodyText = (inbound || [])
    .map((m) => (m.body as string | undefined) || "")
    .join("\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[^;]+;/g, " ");
  if (!bodyText.trim()) return { linkedCount: 0, linkedEmails: [] };

  const { data: primaryCustomer } = await admin
    .from("customers")
    .select("email")
    .eq("id", customerId)
    .single();
  const primaryEmail = (primaryCustomer?.email || "").toLowerCase();

  const linked: string[] = [];

  // ── Email identifiers ──────────────────────────────────────────────
  for (const candidateEmail of extractCandidateEmails(bodyText, primaryEmail)) {
    const { data: target } = await admin
      .from("customers")
      .select("id, email")
      .eq("workspace_id", workspaceId)
      .ilike("email", candidateEmail)
      .maybeSingle();
    if (!target || target.id === customerId) continue;
    if (await linkTwoCustomers(admin, workspaceId, customerId, target.id)) {
      linked.push(target.email || candidateEmail);
    }
  }

  // ── Order-number identifiers ───────────────────────────────────────
  for (const orderNum of extractOrderNumbers(bodyText)) {
    const owner = await resolveOrderOwner(admin, workspaceId, orderNum);
    if (!owner || owner.customerId === customerId) continue;
    if (await linkTwoCustomers(admin, workspaceId, customerId, owner.customerId)) {
      linked.push(`${owner.email || owner.customerId} (order ${orderNum})`);
    }
  }

  return { linkedCount: linked.length, linkedEmails: linked };
}
