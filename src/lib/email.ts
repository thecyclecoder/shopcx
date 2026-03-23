import { Resend } from "resend";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

export async function getResendClient(workspaceId: string): Promise<{ resend: Resend; domain: string } | null> {
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("resend_api_key_encrypted, resend_domain")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.resend_api_key_encrypted || !workspace?.resend_domain) {
    return null;
  }

  const apiKey = decrypt(workspace.resend_api_key_encrypted);
  return {
    resend: new Resend(apiKey),
    domain: workspace.resend_domain,
  };
}

export async function sendInviteEmail({
  workspaceId,
  workspaceName,
  toEmail,
  role,
  invitedByName,
}: {
  workspaceId: string;
  workspaceName: string;
  toEmail: string;
  role: string;
  invitedByName: string;
}) {
  const client = await getResendClient(workspaceId);
  if (!client) return { error: "Resend not configured" };

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";

  const { error } = await client.resend.emails.send({
    from: `ShopCX.AI <noreply@${client.domain}>`,
    to: toEmail,
    subject: `You've been invited to ${workspaceName} on ShopCX.AI`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #18181b; font-size: 20px; margin-bottom: 8px;">You're invited to ${workspaceName}</h2>
        <p style="color: #71717a; font-size: 14px; line-height: 1.6;">
          ${invitedByName} has invited you to join <strong>${workspaceName}</strong> as a <strong>${role.replace("_", " ")}</strong> on ShopCX.AI.
        </p>
        <a href="${siteUrl}/login" style="display: inline-block; margin-top: 24px; padding: 12px 24px; background: #6366f1; color: white; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 500;">
          Accept Invite
        </a>
        <p style="color: #a1a1aa; font-size: 12px; margin-top: 32px;">
          This invite will expire in 7 days. If you didn't expect this email, you can safely ignore it.
        </p>
      </div>
    `,
  });

  if (error) return { error: error.message };
  return { success: true };
}
