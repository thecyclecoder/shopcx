import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendCsatEmail } from "@/lib/email";
import { createHmac } from "crypto";

function generateCsatToken(ticketId: string): string {
  const secret = process.env.ENCRYPTION_KEY || "fallback";
  return createHmac("sha256", secret).update(ticketId).digest("hex").slice(0, 32);
}

export const ticketCsat = inngest.createFunction(
  {
    id: "ticket-csat",
    retries: 2,
    triggers: [{ event: "ticket/closed" }],
  },
  async ({ event, step }) => {
    const { ticket_id, workspace_id, customer_id, subject } = event.data as {
      ticket_id: string;
      workspace_id: string;
      customer_id: string | null;
      subject: string | null;
    };

    if (!customer_id) return { skipped: "no customer" };

    // Wait 24 hours before sending CSAT
    await step.sleep("wait-24h", "24h");

    // Verify ticket is still closed (customer might have replied)
    const admin = createAdminClient();
    const stillClosed: boolean = await step.run("check-still-closed", async () => {
      const { data: ticket } = await admin
        .from("tickets")
        .select("status")
        .eq("id", ticket_id)
        .single();
      return ticket?.status === "closed";
    });

    if (!stillClosed) return { skipped: "ticket reopened" };

    // Get customer email and workspace name
    const info: { email: string; workspaceName: string } | null = await step.run(
      "get-info",
      async () => {
        const { data: customer } = await admin
          .from("customers")
          .select("email")
          .eq("id", customer_id)
          .single();

        const { data: workspace } = await admin
          .from("workspaces")
          .select("name")
          .eq("id", workspace_id)
          .single();

        if (!customer?.email) return null;
        return {
          email: customer.email,
          workspaceName: workspace?.name || "ShopCX",
        };
      }
    );

    if (!info) return { skipped: "no customer email" };

    // Send CSAT email
    await step.run("send-csat", async () => {
      const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
      const token = generateCsatToken(ticket_id);
      const csatUrl = `${siteUrl}/csat/${ticket_id}?token=${token}`;

      await sendCsatEmail({
        workspaceId: workspace_id,
        toEmail: info.email,
        ticketSubject: subject || "Support Request",
        csatUrl,
        workspaceName: info.workspaceName,
      });
    });

    return { sent: true };
  }
);
