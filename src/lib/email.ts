import { Resend } from "resend";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

/**
 * Sandbox gate — in sandbox mode, only allow emails to workspace members.
 * Returns true if the email should be BLOCKED (not sent).
 * Invite emails are always allowed (they go to new members being invited).
 */
async function sandboxBlock(workspaceId: string, toEmail: string, isInvite = false): Promise<boolean> {
  if (isInvite) return false; // Invites always go through
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("sandbox_mode").eq("id", workspaceId).single();
  if (!ws?.sandbox_mode) return false; // Sandbox off — allow all

  // Sandbox on — only allow emails to workspace member emails
  const { data: members } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId);

  const memberEmails = new Set<string>();
  for (const m of members || []) {
    if (m.user_id) {
      const { data: user } = await admin.auth.admin.getUserById(m.user_id);
      if (user?.user?.email) memberEmails.add(user.user.email.toLowerCase());
    }
  }

  const blocked = !memberEmails.has(toEmail.toLowerCase());
  if (blocked) {
    console.log(`[Sandbox] Blocked email to ${toEmail} — not a workspace member. Allowed: ${[...memberEmails].join(", ")}`);
  }
  return blocked;
}

export async function getResendClient(
  workspaceId: string,
  /** If provided, sandbox mode will block emails to non-workspace-member addresses */
  recipientEmail?: string,
): Promise<{ resend: Resend; domain: string; supportEmail: string | null } | null> {
  if (recipientEmail && await sandboxBlock(workspaceId, recipientEmail)) {
    return null; // Blocked by sandbox
  }

  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("resend_api_key_encrypted, resend_domain, support_email")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.resend_api_key_encrypted || !workspace?.resend_domain) {
    return null;
  }

  const apiKey = decrypt(workspace.resend_api_key_encrypted);
  return {
    resend: new Resend(apiKey),
    domain: workspace.resend_domain,
    supportEmail: workspace.support_email || null,
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
  const client = await getResendClient(workspaceId); // invites always allowed, no sandbox gate
  if (!client) return { error: "Resend not configured" };

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";

  const { error } = await client.resend.emails.send({
    from: `ShopCX.ai <noreply@${client.domain}>`,
    to: toEmail,
    subject: `You've been invited to ${workspaceName} on ShopCX.ai`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #18181b; font-size: 20px; margin-bottom: 8px;">You're invited to ${workspaceName}</h2>
        <p style="color: #71717a; font-size: 14px; line-height: 1.6;">
          ${invitedByName} has invited you to join <strong>${workspaceName}</strong> as a <strong>${role.replace("_", " ")}</strong> on ShopCX.ai.
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

export async function sendTicketReply({
  workspaceId,
  toEmail,
  subject,
  body,
  inReplyTo,
  agentName,
  workspaceName,
}: {
  workspaceId: string;
  toEmail: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  agentName: string;
  workspaceName: string;
}): Promise<{ messageId?: string; error?: string }> {
  const client = await getResendClient(workspaceId, toEmail);
  if (!client) return { error: "Resend not configured" };

  const headers: Record<string, string> = {};
  if (inReplyTo) {
    headers["In-Reply-To"] = inReplyTo;
    headers["References"] = inReplyTo;
  }

  const replyTo = client.supportEmail || `support@${client.domain}`;

  const finalSubject = subject.startsWith("Re:") ? subject : inReplyTo ? `Re: ${subject}` : subject;
  console.log("[sendTicketReply]", { subject, inReplyTo: inReplyTo ?? "NULL", finalSubject });

  const { data, error } = await client.resend.emails.send({
    from: `${agentName} via ${workspaceName} <support@${client.domain}>`,
    replyTo,
    to: toEmail,
    subject: finalSubject,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; text-align: left;">
        ${body}
      </div>
    `,
    headers,
  });

  if (error) return { error: error.message };
  return { messageId: data?.id };
}

export async function sendCsatEmail({
  workspaceId,
  toEmail,
  ticketSubject,
  csatUrl,
  workspaceName,
}: {
  workspaceId: string;
  toEmail: string;
  ticketSubject: string;
  csatUrl: string;
  workspaceName: string;
}): Promise<{ error?: string }> {
  const client = await getResendClient(workspaceId, toEmail);
  if (!client) return { error: "Resend not configured" };

  const { error } = await client.resend.emails.send({
    from: `${workspaceName} <support@${client.domain}>`,
    to: toEmail,
    subject: `How did we do? - ${ticketSubject}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; text-align: center;">
        <h2 style="color: #18181b; font-size: 20px; margin-bottom: 8px;">How was your experience?</h2>
        <p style="color: #71717a; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
          Your ticket "<strong>${ticketSubject}</strong>" has been closed. We'd love to hear how we did.
        </p>
        <div style="display: inline-flex; gap: 8px;">
          ${[1, 2, 3, 4, 5]
            .map(
              (n) =>
                `<a href="${csatUrl}&score=${n}" style="display: inline-block; width: 48px; height: 48px; line-height: 48px; text-align: center; border-radius: 8px; background: ${n <= 2 ? "#fef2f2" : n <= 3 ? "#fefce8" : "#f0fdf4"}; color: ${n <= 2 ? "#dc2626" : n <= 3 ? "#ca8a04" : "#16a34a"}; text-decoration: none; font-size: 20px; font-weight: bold;">${n}</a>`
            )
            .join("")}
        </div>
        <p style="color: #a1a1aa; font-size: 11px; margin-top: 24px;">1 = Poor, 5 = Excellent</p>
      </div>
    `,
  });

  if (error) return { error: error.message };
  return {};
}

export async function sendJourneyCTA({
  workspaceId,
  toEmail,
  customerName,
  journeyToken,
  contextMessage,
  workspaceName,
  primaryColor,
  subject,
  buttonLabel,
  inReplyTo,
}: {
  workspaceId: string;
  toEmail: string;
  customerName: string;
  journeyToken: string;
  contextMessage?: string;
  workspaceName: string;
  primaryColor?: string;
  subject?: string;
  buttonLabel?: string;
  inReplyTo?: string | null;
}): Promise<{ error?: string }> {
  const client = await getResendClient(workspaceId, toEmail);
  if (!client) return { error: "Resend not configured" };

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  const journeyUrl = `${siteUrl}/journey/${journeyToken}`;
  const color = primaryColor || "#4f46e5";
  const greeting = customerName ? `Hi ${customerName},` : "Hi there,";
  const btn = buttonLabel || "Continue &rarr;";
  // Unique subject per email to prevent Gmail clipping in threads
  const emailSubject = subject || `Action needed — ${workspaceName}`;

  const headers: Record<string, string> = {};
  if (inReplyTo) {
    headers["In-Reply-To"] = inReplyTo;
    headers["References"] = inReplyTo;
  }

  const { error } = await client.resend.emails.send({
    from: `${workspaceName} <support@${client.domain}>`,
    to: toEmail,
    subject: emailSubject,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 540px; padding: 20px 0;">
        <p style="color: #18181b; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
          ${contextMessage || "We'd love to help you with your request. Please click the button below to continue."}
        </p>
        <div style="margin-top: 24px;">
          <a href="${journeyUrl}" style="display: inline-block; padding: 14px 32px; background: ${color}; color: white; text-decoration: none; border-radius: 10px; font-size: 15px; font-weight: 600;">
            ${btn}
          </a>
        </div>
        <p style="color: #a1a1aa; font-size: 12px; margin-top: 24px;">
          This link expires in 24 hours.
        </p>
      </div>
    `,
  });

  if (error) return { error: error.message };
  return {};
}

// ── Dunning Emails ──

export async function sendDunningPaymentUpdateEmail({
  workspaceId,
  toEmail,
  customerName,
  workspaceName,
  updateUrl,
}: {
  workspaceId: string;
  toEmail: string;
  customerName: string | null;
  workspaceName: string;
  updateUrl: string;
}): Promise<{ error?: string }> {
  const client = await getResendClient(workspaceId, toEmail);
  if (!client) return { error: "Resend not configured" };

  const greeting = customerName ? `Hi ${customerName},` : "Hi there,";

  const { error } = await client.resend.emails.send({
    from: `${workspaceName} <support@${client.domain}>`,
    to: toEmail,
    subject: `Action needed: Update your payment method — ${workspaceName}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #18181b; font-size: 20px; margin-bottom: 8px;">${greeting}</h2>
        <p style="color: #71717a; font-size: 14px; line-height: 1.6;">
          Your recent payment didn't go through. To keep your subscription active and avoid missing your next order, please update your payment method.
        </p>
        <div style="text-align: center; margin-top: 32px;">
          <a href="${updateUrl}" style="display: inline-block; padding: 14px 32px; background: #6366f1; color: white; text-decoration: none; border-radius: 10px; font-size: 15px; font-weight: 600;">
            Update Payment Method
          </a>
        </div>
        <p style="color: #a1a1aa; font-size: 12px; margin-top: 32px; text-align: center;">
          If you've already updated your card, you can ignore this email. Your next payment will be retried automatically.
        </p>
      </div>
    `,
  });

  if (error) return { error: error.message };
  return {};
}

export async function sendDunningRecoveryEmail({
  workspaceId,
  toEmail,
  customerName,
  workspaceName,
}: {
  workspaceId: string;
  toEmail: string;
  customerName: string | null;
  workspaceName: string;
}): Promise<{ error?: string }> {
  const client = await getResendClient(workspaceId, toEmail);
  if (!client) return { error: "Resend not configured" };

  const greeting = customerName ? `Hi ${customerName},` : "Hi there,";

  const { error } = await client.resend.emails.send({
    from: `${workspaceName} <support@${client.domain}>`,
    to: toEmail,
    subject: `Payment confirmed — ${workspaceName}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #18181b; font-size: 20px; margin-bottom: 8px;">${greeting}</h2>
        <p style="color: #71717a; font-size: 14px; line-height: 1.6;">
          Great news — your payment went through! Your subscription is back on track and your next order is on its way.
        </p>
        <p style="color: #a1a1aa; font-size: 12px; margin-top: 32px;">
          No action needed. Thanks for being a subscriber!
        </p>
      </div>
    `,
  });

  if (error) return { error: error.message };
  return {};
}

export async function sendDunningPausedEmail({
  workspaceId,
  toEmail,
  customerName,
  workspaceName,
  updateUrl,
}: {
  workspaceId: string;
  toEmail: string;
  customerName: string | null;
  workspaceName: string;
  updateUrl: string;
}): Promise<{ error?: string }> {
  const client = await getResendClient(workspaceId, toEmail);
  if (!client) return { error: "Resend not configured" };

  const greeting = customerName ? `Hi ${customerName},` : "Hi there,";

  const { error } = await client.resend.emails.send({
    from: `${workspaceName} <support@${client.domain}>`,
    to: toEmail,
    subject: `Your subscription has been paused — ${workspaceName}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #18181b; font-size: 20px; margin-bottom: 8px;">${greeting}</h2>
        <p style="color: #71717a; font-size: 14px; line-height: 1.6;">
          We weren't able to process your payment after multiple attempts, so your subscription has been paused. Update your payment method below to resume your subscription — we'll get your next order on its way right away.
        </p>
        <div style="text-align: center; margin-top: 32px;">
          <a href="${updateUrl}" style="display: inline-block; padding: 14px 32px; background: #6366f1; color: white; text-decoration: none; border-radius: 10px; font-size: 15px; font-weight: 600;">
            Update Payment Method
          </a>
        </div>
        <p style="color: #a1a1aa; font-size: 12px; margin-top: 32px; text-align: center;">
          If you have questions, just reply to this email and we'll help you out.
        </p>
      </div>
    `,
  });

  if (error) return { error: error.message };
  return {};
}

export async function sendReturnConfirmationEmail({
  workspaceId,
  toEmail,
  customerName,
  orderNumber,
  resolutionType,
}: {
  workspaceId: string;
  toEmail: string;
  customerName: string | null;
  orderNumber: string;
  resolutionType: string;
}): Promise<{ error?: string }> {
  const client = await getResendClient(workspaceId, toEmail);
  if (!client) return { error: "Resend not configured" };

  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspaceId).single();
  const workspaceName = ws?.name || "Support";

  const greeting = customerName ? `Hi ${customerName},` : "Hi there,";
  const isCredit = resolutionType.includes("store_credit");
  const resolutionLabel = isCredit ? "store credit" : "refund";

  const { error } = await client.resend.emails.send({
    from: `${workspaceName} <support@${client.domain}>`,
    to: toEmail,
    subject: `Your return for order ${orderNumber} has been processed`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #18181b; font-size: 20px; margin-bottom: 8px;">${greeting}</h2>
        <p style="color: #71717a; font-size: 14px; line-height: 1.6;">
          Your return for order <strong>${orderNumber}</strong> has been processed and your ${resolutionLabel} has been issued.${isCredit ? " The credit has been added to your account." : " Please allow a few business days for the refund to appear on your statement."}
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
