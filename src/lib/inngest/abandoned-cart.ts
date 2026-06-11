/**
 * Abandoned-cart reminder cron. Fires every 10 minutes; for each
 * cart_draft that's been idle for 30+ minutes with no conversion and
 * an email on file, sends a single "you left something behind"
 * email and stamps abandoned_email_sent_at so we never send twice
 * for the same draft.
 *
 * Idle = updated_at < now() - 30 min. Every /api/cart write bumps
 * updated_at, so an actively-edited cart never qualifies. A cart
 * resurrected by the customer (returning to /customize, mutating a
 * line) advances updated_at but does NOT clear abandoned_email_sent_at —
 * one reminder per draft, lifetime.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendCartRecovery } from "@/lib/cart-recovery";

const IDLE_MINUTES = 30;
const BATCH_SIZE = 50;

interface CartDraftRow {
  id: string;
  workspace_id: string;
  token: string;
  email: string;
  customer_id: string | null;
  line_items: Array<{
    title?: string;
    variant_title?: string | null;
    quantity?: number;
    unit_price_cents?: number;
    unit_msrp_cents?: number;
    line_total_cents?: number;
    image_url?: string | null;
    is_gift?: boolean;
  }>;
  subtotal_cents: number;
  updated_at: string;
}

export const abandonedCartReminder = inngest.createFunction(
  {
    id: "abandoned-cart-reminder",
    name: "Storefront — abandoned cart reminder",
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "*/10 * * * *" },
      { event: "storefront/abandoned-cart.tick" },
    ],
  },
  async ({ step }) => {
    const due = await step.run("find-idle-carts", async () => {
      const admin = createAdminClient();
      const cutoffIso = new Date(Date.now() - IDLE_MINUTES * 60_000).toISOString();
      const { data, error } = await admin
        .from("cart_drafts")
        .select("id, workspace_id, token, email, customer_id, line_items, subtotal_cents, updated_at")
        .eq("status", "open")
        .not("email", "is", null)
        .is("abandoned_email_sent_at", null)
        .lte("updated_at", cutoffIso)
        .order("updated_at", { ascending: true })
        .limit(BATCH_SIZE);
      if (error) {
        console.error("[abandoned-cart] find error:", error.message);
        return [] as CartDraftRow[];
      }
      // Defensive filter: drafts whose line_items array is empty are
      // skipped — could happen if the customer added then removed all
      // items, leaving an empty token-bound row.
      return (data || []).filter((d) => Array.isArray(d.line_items) && d.line_items.length > 0) as CartDraftRow[];
    });

    if (due.length === 0) return { sent: 0, scanned: 0 };

    // Cache workspace branding + customer first-name lookups so the
    // batch shares a single round trip per workspace.
    const workspaceIds = Array.from(new Set(due.map((d) => d.workspace_id)));
    const customerIds = Array.from(new Set(due.map((d) => d.customer_id).filter((id): id is string => !!id)));
    const { storefrontDomains, firstNamesByCustomer } = await step.run("prefetch", async () => {
      const admin = createAdminClient();
      const { data: ws } = await admin
        .from("workspaces")
        .select("id, storefront_domain")
        .in("id", workspaceIds);
      const domains = new Map<string, string | null>();
      for (const w of ws || []) domains.set(w.id, (w.storefront_domain as string | null) || null);

      const names = new Map<string, string>();
      if (customerIds.length > 0) {
        const { data: cs } = await admin
          .from("customers")
          .select("id, first_name")
          .in("id", customerIds);
        for (const c of cs || []) {
          if (c.first_name) names.set(c.id, c.first_name as string);
        }
      }
      return {
        storefrontDomains: Object.fromEntries(domains),
        firstNamesByCustomer: Object.fromEntries(names),
      };
    });

    let sent = 0;
    let failed = 0;
    for (const cart of due) {
      const result = await step.run(`send-${cart.id}`, async () => {
        const lineItems = cart.line_items.map((l) => ({
          title: l.title || "Item",
          variant_title: l.variant_title || null,
          quantity: l.quantity || 1,
          unit_price_cents: l.unit_price_cents,
          unit_msrp_cents: l.unit_msrp_cents,
          line_total_cents: l.line_total_cents,
          image_url: l.image_url || null,
          is_gift: l.is_gift || false,
          product_id: (l as { product_id?: string }).product_id,
        }));
        const res = await sendCartRecovery({
          workspaceId: cart.workspace_id,
          cartToken: cart.token,
          customerId: cart.customer_id,
          email: cart.email,
          lineItems,
          subtotalCents: cart.subtotal_cents,
          storefrontDomain: storefrontDomains[cart.workspace_id] || null,
        });
        // Stamp abandoned_email_sent_at even on failure to avoid retry
        // storms — better to lose one reminder than spam a customer
        // because of a transient Resend hiccup. The error reason is
        // logged for ops to triage.
        const admin = createAdminClient();
        await admin
          .from("cart_drafts")
          .update({ abandoned_email_sent_at: new Date().toISOString() })
          .eq("id", cart.id);
        if (!res.success) {
          console.error(`[abandoned-cart] send failed for cart ${cart.id}: ${res.error}`);
        }
        return res.success;
      });
      if (result) sent++; else failed++;
    }

    return { sent, failed, scanned: due.length };
  },
);
