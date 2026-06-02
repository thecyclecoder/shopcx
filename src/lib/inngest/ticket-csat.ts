/**
 * CSAT survey sender — cron-driven, not sleep-step.
 *
 * Runs every 15 minutes. Finds tickets that closed at least 48h ago
 * with a customer email and no csat_sent_at marker, sends the CSAT
 * email, stamps csat_sent_at. Idempotent (the index filters out
 * already-sent rows).
 *
 * 48h delay so fulfillment outcomes (replacement orders arriving,
 * refunds hitting the card) usually land before the customer rates.
 *
 * Stamp happens BEFORE the send call so a Resend hiccup doesn't
 * cause a re-send storm on the next cron tick.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendCsatEmail } from "@/lib/email";
import { createHmac } from "crypto";

const CSAT_DELAY_HOURS = 48;
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
    const since = new Date(Date.now() - CSAT_DELAY_HOURS * 60 * 60 * 1000).toISOString();

    const due = await step.run("find-due", async () => {
      const { data } = await admin
        .from("tickets")
        .select("id, workspace_id, customer_id, subject")
        .eq("status", "closed")
        .is("csat_sent_at", null)
        .not("customer_id", "is", null)
        .not("closed_at", "is", null)
        .lte("closed_at", since)
        .order("closed_at", { ascending: true })
        .limit(BATCH_SIZE);
      return data || [];
    });

    if (!due.length) return { sent: 0 };

    let sent = 0;
    for (const t of due) {
      await step.run(`send-${t.id}`, async () => {
        // Stamp first so a partial-failure doesn't re-fire next tick.
        await admin.from("tickets")
          .update({ csat_sent_at: new Date().toISOString() })
          .eq("id", t.id);

        const [{ data: customer }, { data: workspace }] = await Promise.all([
          admin.from("customers").select("email").eq("id", t.customer_id!).single(),
          admin.from("workspaces").select("name").eq("id", t.workspace_id).single(),
        ]);
        if (!customer?.email) return;

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
        sent++;
      });
    }

    return { sent, batch_size: due.length };
  },
);
