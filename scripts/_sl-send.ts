/** Resend sender — full HTML doc (already brand-shelled), no extra wrapper. */
import { createAdminClient } from "../src/lib/supabase/admin";
export async function sendBrandedEmail(workspaceId: string, to: string, subject: string, html: string, text: string) {
  const admin = createAdminClient() as any;
  const { data: ws } = await admin.from("workspaces")
    .select("resend_api_key_encrypted, resend_domain, name, transactional_from_name, transactional_reply_to_email")
    .eq("id", workspaceId).maybeSingle();
  const { decrypt } = await import("../src/lib/crypto");
  const key = ws?.resend_api_key_encrypted ? decrypt(ws.resend_api_key_encrypted) : process.env.RESEND_API_KEY;
  if (!key) return { error: "Resend not configured" };
  const domain = ws?.resend_domain || "superfoodscompany.com";
  const from = `${ws?.transactional_from_name || ws?.name || "Superfoods Company"} <orders@${domain}>`;
  const { Resend } = await import("resend");
  const resend = new Resend(key);
  const { data, error } = await resend.emails.send({
    from, to, subject, html, text, replyTo: ws?.transactional_reply_to_email || `support@${domain}`,
  });
  return error ? { error: error.message } : { messageId: data?.id };
}
