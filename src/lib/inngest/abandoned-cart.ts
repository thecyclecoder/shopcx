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

const IDLE_MINUTES = 30;       // first touch: 30 min after the cart goes idle
const FOLLOWUP_HOURS = 24;     // second touch: 24 h after the first touch
const REENTRY_COOLDOWN_DAYS = 3; // a customer can't re-enter the flow (new cart → first touch) within this window of a prior first touch
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
    product_id?: string;
  }>;
  subtotal_cents: number;
  updated_at: string;
  /** True for the second-touch (24 h) follow-up; false for the first touch. */
  followUp: boolean;
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
      const SEL = "id, workspace_id, token, email, customer_id, line_items, subtotal_cents, updated_at";
      const nonEmpty = (rows: unknown[] | null) =>
        (rows || []).filter((d) => Array.isArray((d as CartDraftRow).line_items) && (d as CartDraftRow).line_items.length > 0) as CartDraftRow[];

      // First touch — open carts with an email, idle 30+ min, never messaged.
      const firstCutoff = new Date(Date.now() - IDLE_MINUTES * 60_000).toISOString();
      const { data: first, error: e1 } = await admin
        .from("cart_drafts")
        .select(SEL)
        .eq("status", "open")
        .not("email", "is", null)
        .is("abandoned_email_sent_at", null)
        .lte("updated_at", firstCutoff)
        .order("updated_at", { ascending: true })
        .limit(BATCH_SIZE);
      if (e1) console.error("[abandoned-cart] first-touch find error:", e1.message);

      // Second touch — got the first message ≥24 h ago, still open, no follow-up
      // yet. (Still gated on status='open' so a converted cart never gets one.)
      const followCutoff = new Date(Date.now() - FOLLOWUP_HOURS * 3_600_000).toISOString();
      const { data: follow, error: e2 } = await admin
        .from("cart_drafts")
        .select(SEL)
        .eq("status", "open")
        .not("email", "is", null)
        .not("abandoned_email_sent_at", "is", null)
        .is("abandoned_followup_sent_at", null)
        .lte("abandoned_email_sent_at", followCutoff)
        .order("abandoned_email_sent_at", { ascending: true })
        .limit(BATCH_SIZE);
      if (e2) console.error("[abandoned-cart] follow-up find error:", e2.message);

      // Re-entry cooldown — a customer who already got a FIRST touch in the last
      // 3 days must not be put back into the flow for a different cart. They
      // still complete the two touches of the cart they're already in (the
      // `follow` query is intentionally NOT filtered here). Dedupe by both
      // email and customer_id (per workspace) so it holds whether the cart was
      // anonymous-with-email or stitched to an account.
      const firstCarts = nonEmpty(first);
      let allowedFirst = firstCarts;
      if (firstCarts.length > 0) {
        const cooldownCutoff = new Date(Date.now() - REENTRY_COOLDOWN_DAYS * 86_400_000).toISOString();
        const { data: recentTouches } = await admin
          .from("cart_drafts")
          .select("workspace_id, email, customer_id")
          .not("abandoned_email_sent_at", "is", null)
          .gte("abandoned_email_sent_at", cooldownCutoff);
        const emailKey = (ws: string, email: string | null) => `${ws}|${(email || "").toLowerCase()}`;
        const recentEmails = new Set<string>();
        const recentCustomers = new Set<string>();
        for (const r of recentTouches || []) {
          if (r.email) recentEmails.add(emailKey(r.workspace_id as string, r.email as string));
          if (r.customer_id) recentCustomers.add(r.customer_id as string);
        }
        allowedFirst = firstCarts.filter(
          (c) =>
            !recentEmails.has(emailKey(c.workspace_id, c.email)) &&
            !(c.customer_id && recentCustomers.has(c.customer_id)),
        );
        const skipped = firstCarts.length - allowedFirst.length;
        if (skipped > 0) console.log(`[abandoned-cart] cooldown skipped ${skipped} first-touch cart(s) (re-entry within ${REENTRY_COOLDOWN_DAYS}d)`);
      }

      return [
        ...allowedFirst.map((d) => ({ ...d, followUp: false })),
        ...nonEmpty(follow).map((d) => ({ ...d, followUp: true })),
      ];
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
          followUp: cart.followUp,
        });
        // Stamp the appropriate timestamp even on failure to avoid retry storms
        // — better to lose one reminder than spam a customer over a transient
        // Resend/Twilio hiccup. The follow-up stamps its own column so it never
        // re-sends; the first touch stamps abandoned_email_sent_at.
        const admin = createAdminClient();
        await admin
          .from("cart_drafts")
          .update({ [cart.followUp ? "abandoned_followup_sent_at" : "abandoned_email_sent_at"]: new Date().toISOString() })
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
