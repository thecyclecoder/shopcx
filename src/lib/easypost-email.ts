// Return label email — sends label PDF link + tracking + refund breakdown to customer

import { getResendClient } from "@/lib/email";
import { createAdminClient } from "@/lib/supabase/admin";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function sendReturnLabelEmail({
  workspaceId,
  toEmail,
  customerName,
  orderNumber,
  trackingNumber,
  carrier,
  labelUrl,
  labelCostCents,
  orderTotalCents,
  netRefundCents,
  resolutionType,
}: {
  workspaceId: string;
  toEmail: string;
  customerName: string | null;
  orderNumber: string;
  trackingNumber: string;
  carrier: string;
  labelUrl: string;
  labelCostCents: number;
  orderTotalCents: number;
  netRefundCents: number;
  resolutionType: string;
}): Promise<{ error?: string }> {
  const client = await getResendClient(workspaceId, toEmail);
  if (!client) return { error: "Resend not configured" };

  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("name")
    .eq("id", workspaceId)
    .single();
  const workspaceName = ws?.name || "Support";

  const greeting = customerName ? `Hi ${customerName},` : "Hi there,";
  const isCredit = resolutionType.includes("store_credit");
  const resolutionLabel = isCredit ? "store credit" : "refund";
  const carrierName = carrier.toUpperCase();

  const { error } = await client.resend.emails.send({
    from: `${workspaceName} <support@${client.domain}>`,
    to: toEmail,
    subject: `Your return label for order ${orderNumber}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #18181b; font-size: 20px; margin-bottom: 8px;">${greeting}</h2>
        <p style="color: #3f3f46; font-size: 14px; line-height: 1.6;">
          We've generated a return shipping label for your order <strong>${orderNumber}</strong>. Print the label, attach it to your package, and drop it off at any ${carrierName} location.
        </p>

        <div style="text-align: center; margin: 28px 0;">
          <a href="${labelUrl}" style="display: inline-block; padding: 14px 32px; background: #6366f1; color: white; text-decoration: none; border-radius: 10px; font-size: 15px; font-weight: 600;">
            Download Return Label (PDF)
          </a>
        </div>

        <div style="background: #f4f4f5; border-radius: 10px; padding: 20px; margin: 24px 0;">
          <p style="margin: 0 0 8px; color: #71717a; font-size: 13px;">Tracking number</p>
          <p style="margin: 0 0 16px; color: #18181b; font-size: 14px; font-weight: 500; font-family: monospace;">${trackingNumber}</p>
          <p style="margin: 0 0 8px; color: #71717a; font-size: 13px;">Your ${resolutionLabel} breakdown</p>
          <table style="width: 100%; font-size: 14px; color: #3f3f46;">
            <tr>
              <td style="padding: 4px 0;">Order total</td>
              <td style="padding: 4px 0; text-align: right;">${formatCents(orderTotalCents)}</td>
            </tr>
            ${netRefundCents < orderTotalCents ? `<tr>
              <td style="padding: 4px 0;">Return shipping</td>
              <td style="padding: 4px 0; text-align: right; color: #dc2626;">-${formatCents(labelCostCents)}</td>
            </tr>` : ""}
            <tr style="border-top: 1px solid #d4d4d8;">
              <td style="padding: 8px 0 0; font-weight: 600; color: #18181b;">Your ${resolutionLabel}</td>
              <td style="padding: 8px 0 0; text-align: right; font-weight: 600; color: #18181b;">${formatCents(netRefundCents)}</td>
            </tr>
          </table>
        </div>

        <p style="color: #71717a; font-size: 14px; line-height: 1.6;">
          We'll automatically track your return and process your ${resolutionLabel} once we receive it.
        </p>

        <p style="color: #a1a1aa; font-size: 12px; margin-top: 32px;">
          If you have questions, just reply to this email and we'll help you out.
        </p>
      </div>
    `,
  });

  if (error) return { error: error.message };
  return {};
}
