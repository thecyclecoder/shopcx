/**
 * Pre-orchestrator helper: scan a customer's latest inbound message
 * for email addresses that match existing-but-unlinked customer
 * profiles in the same workspace, and link them automatically.
 *
 * The motivating case (ticket 9f87b748): customer wrote in from email
 * A complaining about charges, and explicitly mentioned "my
 * husband's email is B" in the same message. The orchestrator
 * shouldn't have to ask the linking question — the answer is
 * already in the message. By linking before Sonnet runs, the
 * orchestrator's get_customer_account tool returns the merged
 * subscription set, and it can route straight to the right journey
 * (cancel, in that case).
 *
 * Mirrors the same logic already in launchJourneyForTicket's
 * "fast path" for the account_linking journey, but runs PROACTIVELY
 * on every customer inbound — not just after we've already sent the
 * linking journey.
 *
 * Returns the number of new links made + the linked email(s) for
 * logging. Never throws — auto-linking is best-effort, the
 * orchestrator runs regardless.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";

interface AutoLinkResult {
  linkedCount: number;
  linkedEmails: string[];
}

/**
 * Conservative email regex — matches common email shapes without
 * trying to perfectly implement RFC 5322. Multiline-aware (some
 * inbound emails carry newlines mid-text).
 */
const EMAIL_REGEX = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;

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

export async function autoLinkCustomerFromMessage(
  admin: SupabaseClient,
  workspaceId: string,
  ticketId: string,
  customerId: string,
): Promise<AutoLinkResult> {
  // Pull the latest inbound external message on this ticket. That's
  // the one the orchestrator is about to handle.
  const { data: lastInbound } = await admin
    .from("ticket_messages")
    .select("body")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .eq("visibility", "external")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const bodyText = ((lastInbound?.body as string | undefined) || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[^;]+;/g, " ");
  if (!bodyText) return { linkedCount: 0, linkedEmails: [] };

  const matches = bodyText.match(EMAIL_REGEX);
  if (!matches || matches.length === 0) return { linkedCount: 0, linkedEmails: [] };

  // De-dupe + filter out anything that's clearly not a real customer
  // address (our own domain, transactional senders, role aliases).
  const candidateEmails = Array.from(new Set(matches.map((m) => m.toLowerCase())))
    .filter((e) => {
      const domain = e.split("@")[1] || "";
      if (!domain) return false;
      for (const ignored of IGNORED_EMAIL_DOMAINS) {
        if (domain === ignored || domain.endsWith(`.${ignored}`) || e.startsWith(`${ignored}@`)) {
          return false;
        }
      }
      return true;
    });
  if (candidateEmails.length === 0) return { linkedCount: 0, linkedEmails: [] };

  // Skip the email of the current customer (they're already
  // themselves — no link to make).
  const { data: primaryCustomer } = await admin
    .from("customers")
    .select("email")
    .eq("id", customerId)
    .single();
  const primaryEmail = (primaryCustomer?.email || "").toLowerCase();

  // For each candidate, find a matching customer in the same
  // workspace. If found and not already linked to this ticket's
  // primary, link them.
  const linked: string[] = [];
  for (const candidateEmail of candidateEmails) {
    if (candidateEmail === primaryEmail) continue;

    const { data: target } = await admin
      .from("customers")
      .select("id, email")
      .eq("workspace_id", workspaceId)
      .ilike("email", candidateEmail)
      .maybeSingle();
    if (!target || target.id === customerId) continue;

    // Already in the same link group?
    const { data: ownerLink } = await admin
      .from("customer_links")
      .select("group_id, is_primary")
      .eq("customer_id", customerId)
      .maybeSingle();
    const { data: targetLink } = await admin
      .from("customer_links")
      .select("group_id")
      .eq("customer_id", target.id)
      .maybeSingle();
    const alreadyLinked = ownerLink && targetLink && ownerLink.group_id === targetLink.group_id;
    if (alreadyLinked) continue;

    // Make the link. Group id = existing group on either side, else
    // new uuid. Upsert both rows; the primary flag is set only on
    // the ticket's current customer (preserves existing primary
    // status if there already was one).
    const groupId = ownerLink?.group_id || targetLink?.group_id || crypto.randomUUID();
    if (!ownerLink) {
      await admin.from("customer_links").upsert(
        {
          customer_id: customerId,
          workspace_id: workspaceId,
          group_id: groupId,
          is_primary: true,
        },
        { onConflict: "customer_id" },
      );
    }
    await admin.from("customer_links").upsert(
      {
        customer_id: target.id,
        workspace_id: workspaceId,
        group_id: groupId,
        is_primary: false,
      },
      { onConflict: "customer_id" },
    );

    linked.push(target.email || candidateEmail);
  }

  return { linkedCount: linked.length, linkedEmails: linked };
}
