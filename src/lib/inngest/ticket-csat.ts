/**
 * CSAT survey sender — cron-driven, not sleep-step.
 *
 * Runs every 15 minutes. Sends a CSAT email when a ticket has been
 * closed for 48h-7d AND has a customer email AND no csat_sent_at
 * marker. Idempotent (the index filters out already-sent rows).
 *
 * Two windows:
 *   - DELAY (48h)   — wait this long after close so fulfillment
 *                     outcomes (replacement orders arriving, refunds
 *                     hitting the card) usually land before the
 *                     customer rates.
 *   - MAX_AGE (7d)  — don't send to people whose ticket closed weeks
 *                     ago. Asking 'how did we do?' on a 3-month-old
 *                     ticket gets marked as spam. Tickets older than
 *                     this get stamped as skipped so they don't keep
 *                     showing up in the cron query.
 *
 * Stamp happens BEFORE the send call so a Resend hiccup doesn't
 * cause a re-send storm on the next cron tick.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendCsatEmail } from "@/lib/email";
import { SKIP_TAGS } from "@/lib/ticket-tags";
import { createHmac } from "crypto";

const CSAT_DELAY_HOURS = 48;
const CSAT_MAX_AGE_HOURS = 7 * 24;
const BATCH_SIZE = 50;

function generateCsatToken(ticketId: string): string {
  const secret = process.env.ENCRYPTION_KEY || "fallback";
  return createHmac("sha256", secret).update(ticketId).digest("hex").slice(0, 32);
}

export const ticketCsatCron = inngest.createFunction(
  {
    id: "ticket-csat-cron",
    name: "CSAT — send surveys 48h after ticket close",
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const now = Date.now();
    const oldestEligible = new Date(now - CSAT_DELAY_HOURS * 60 * 60 * 1000).toISOString();
    const tooOld = new Date(now - CSAT_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

    // First pass: any ticket closed BEFORE the max-age cutoff with no
    // marker — stamp as skipped. This catches the migration-day
    // backlog (every old closed ticket has csat_sent_at NULL because
    // the column was just added) and prevents the cron from scanning
    // them every 15 min forever.
    const skippedCount = await step.run("skip-too-old", async () => {
      const { data } = await admin
        .from("tickets")
        .select("id")
        .eq("status", "closed")
        .is("csat_sent_at", null)
        .not("customer_id", "is", null)
        .not("closed_at", "is", null)
        .lt("closed_at", tooOld)
        .limit(500);
      if (!data?.length) return 0;
      await admin.from("tickets")
        .update({ csat_sent_at: new Date().toISOString() })
        .in("id", data.map(t => t.id));
      return data.length;
    });

    // Second pass: in-window tickets to send to.
    const due = await step.run("find-due", async () => {
      const { data } = await admin
        .from("tickets")
        .select("id, workspace_id, customer_id, subject, do_not_reply, tags")
        .eq("status", "closed")
        .is("csat_sent_at", null)
        .not("customer_id", "is", null)
        .not("closed_at", "is", null)
        .gte("closed_at", tooOld)
        .lte("closed_at", oldestEligible)
        .order("closed_at", { ascending: true })
        .limit(BATCH_SIZE);
      return data || [];
    });

    if (!due.length) return { sent: 0, skipped_too_old: skippedCount, skipped_no_reply: 0 };

    let sent = 0;
    let skippedNoReply = 0;
    for (const t of due) {
      const result = await step.run(`send-${t.id}`, async () => {
        // ── Eligibility guard ──
        // Only survey tickets we actually engaged. Skip — and stamp
        // csat_sent_at so the ticket leaves the scan window (mirrors the
        // too-old skip path) — when ANY of:
        //   1. We never sent the customer a customer-facing outbound
        //      message (no outbound row with non-internal visibility).
        //      The principled, universal signal: nothing to rate.
        //   2. do_not_reply — the AI intentionally didn't reply (wrong
        //      company / spam); same flag the analyzer skips on.
        //   3. Tags overlap SKIP_TAGS (outreach / auto-reply / spam) —
        //      cheap early filter, shared with the analyzer.
        const tags = (t.tags as string[] | null) || [];
        let ineligible = t.do_not_reply === true || tags.some(tag => SKIP_TAGS.has(tag));

        if (!ineligible) {
          const { count } = await admin
            .from("ticket_messages")
            .select("id", { count: "exact", head: true })
            .eq("ticket_id", t.id)
            .eq("direction", "outbound")
            .neq("visibility", "internal");
          ineligible = (count ?? 0) === 0;
        }

        if (ineligible) {
          // Stamp so it leaves the scan window; send nothing.
          await admin.from("tickets")
            .update({ csat_sent_at: new Date().toISOString() })
            .eq("id", t.id);
          return "skipped_no_reply" as const;
        }

        // Stamp first so a partial-failure doesn't re-fire next tick.
        await admin.from("tickets")
          .update({ csat_sent_at: new Date().toISOString() })
          .eq("id", t.id);

        const [{ data: customer }, { data: workspace }] = await Promise.all([
          admin.from("customers").select("email").eq("id", t.customer_id!).single(),
          admin.from("workspaces").select("name").eq("id", t.workspace_id).single(),
        ]);
        if (!customer?.email) return "no_email" as const;

        const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
        const token = generateCsatToken(t.id);
        const csatUrl = `${siteUrl}/csat/${t.id}?token=${token}`;

        await sendCsatEmail({
          workspaceId: t.workspace_id,
          toEmail: customer.email,
          ticketSubject: t.subject || "Support Request",
          csatUrl,
          workspaceName: workspace?.name || "ShopCX",
        });
        return "sent" as const;
      });
      if (result === "sent") sent++;
      else if (result === "skipped_no_reply") skippedNoReply++;
    }

    return { sent, skipped_too_old: skippedCount, skipped_no_reply: skippedNoReply, batch_size: due.length };
  },
);
