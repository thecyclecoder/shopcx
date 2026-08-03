/**
 * ticket-delivery — deliver ONE outbound customer-facing message on a ticket's
 * channel, the way production does it.
 *
 * This is the portal-aware delivery sink the Improve executor passes to
 * executeSonnetDecision (improve-plan-executor.ts → orchestrator_action). It
 * mirrors the `send()` helper in inngest/unified-ticket-handler.ts so an
 * operator-approved action reaches the customer through the SAME per-channel
 * path the orchestrator uses — email via sendTicketReply, **portal via
 * sendPortalThreadEmail** (the gap the old improve-actions send_message had:
 * it only emailed when channel==='email', so a portal customer never got the
 * mail), and chat with the idle→email fallback.
 *
 * Differences from the orchestrator's send(): no pending/delay machinery —
 * an operator already approved this action, so it delivers immediately. The
 * "identical ticket messages" invariant (CLAUDE.md) still holds because the
 * rendered body (toHtml + translation + label-CTA) and the channel handling
 * match.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTicketReply } from "@/lib/email";
import { ctaButton, renderLabelUrlsAsButtons } from "@/lib/label-cta";

type Admin = ReturnType<typeof createAdminClient>;

// Same paragraph→HTML shaping the orchestrator's send() uses.
const toHtml = (t: string) =>
  t
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

/**
 * Placeholder guarantee at the delivery chokepoint (docs/brain/specs/
 * no-send-path-can-emit-an-unsubstituted-placeholder). Every outbound customer
 * message runs through this before render/send: an unfilled `{{label_url}}`
 * falls back to the customer's most recent non-terminal `returns` row (Ethel
 * 2305546a, Julianne de357c10 both had the label on the return the whole
 * time), and any residual `{{token}}` / `[UPPER_TOKEN]` is stripped so the
 * literal brace text can NEVER reach the customer. Bounded to `customerId`
 * — never guess across customers. Exported so the regression tests can pin
 * the three named cases without spinning up a live delivery.
 */
export async function resolvePlaceholderSafeMessage(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
  customerId: string | null,
  message: string,
): Promise<string> {
  const PLACEHOLDER_RE = /\{\{\s*\w+\s*\}\}|\[\s*[A-Z_]+\s*\]/;
  const LABEL_URL_TOKEN_RE = /\{\{\s*label_url\s*\}\}|\[\s*LABEL_URL\s*\]/;
  let safeMessage = message;

  if (customerId && LABEL_URL_TOKEN_RE.test(safeMessage)) {
    const { data: liveReturn } = await admin
      .from("returns")
      .select("id, label_url, status, created_at")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .not("label_url", "is", null)
      .not("status", "in", "(refunded,cancelled,closed)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (liveReturn?.label_url) {
      const button = ctaButton(liveReturn.label_url, "Download your prepaid return label →");
      safeMessage = safeMessage
        .replace(/\{\{\s*label_url\s*\}\}/g, button)
        .replace(/\[\s*LABEL_URL\s*\]/g, button);
      console.info(
        `[deliverTicketMessage] filled {{label_url}} from live return ticket=${ticketId} return=${liveReturn.id} status=${liveReturn.status}`,
      );
    }
  }

  if (PLACEHOLDER_RE.test(safeMessage)) {
    const { stripUnsubstitutedPlaceholders } = await import("@/lib/action-executor");
    console.warn(
      `[deliverTicketMessage] stripping unsubstituted placeholder(s) in outbound message ticket=${ticketId}:`,
      safeMessage.match(/\{\{\s*\w+\s*\}\}|\[\s*[A-Z_]+\s*\]/g),
    );
    safeMessage = stripUnsubstitutedPlaceholders(safeMessage);
  }

  return safeMessage;
}

/**
 * Insert an outbound external message on `ticketId` and deliver it on the
 * ticket's `channel`. In sandbox mode the message is logged as an internal
 * draft and nothing is sent.
 *
 * Returns nothing — failures are best-effort logged via console; the caller
 * (executeSonnetDecision) tracks messageSent independently.
 */
export async function deliverTicketMessage(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
  channel: string,
  message: string,
  sandbox: boolean,
): Promise<void> {
  const { data: t } = await admin
    .from("tickets")
    .select("subject, email_message_id, customer_id, detected_language")
    .eq("id", ticketId)
    .single();

  // Placeholder safety net at the delivery chokepoint. See
  // `resolvePlaceholderSafeMessage` above for the guarantee — this is the
  // single chokepoint call that pins it. The strip is idempotent: a message
  // already filled by an upstream composer has no matching tokens, so this
  // is a no-op safety net under the existing callers, not a replacement for
  // them. WARN with the ticket id (inside the helper) when a strip fires so
  // the upstream caller can be located.
  const safeMessage = await resolvePlaceholderSafeMessage(
    admin,
    workspaceId,
    ticketId,
    t?.customer_id ?? null,
    message,
  );

  // Translate to the customer's detected language (matches the orchestrator's
  // sendWithDelay) so a non-English customer never gets an English body.
  let body = safeMessage;
  const lang = (t?.detected_language as string | null) || "en";
  if (lang && lang !== "en") {
    const { translateIfNeeded } = await import("@/lib/translate");
    body = await translateIfNeeded(safeMessage, lang, { workspaceId, ticketId });
  }
  // Render any bare return-label URL as a CTA button (same safety net as the
  // orchestrator). Runs after translation so the button markup isn't mangled.
  const html = renderLabelUrlsAsButtons(toHtml(body));

  const { addTicketTag } = await import("@/lib/ticket-tags");
  await addTicketTag(ticketId, "ai");

  if (sandbox) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "ai",
      body: `[AI Draft] ${html}`,
    });
    return;
  }

  // Insert the outbound message (visible in UI immediately).
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "external",
    author_type: "ai",
    body: html,
    sent_at: new Date().toISOString(),
  });

  // Mark the ticket AI-handled (any tier: Haiku/Sonnet orchestrator, Sol, journey, playbook —
  // they ALL deliver the customer-facing reply through here). `ai_handled_at` is the universal
  // "we responded to the customer" signal the Cora grading cron selects on, so the cheap pass
  // grades our low-cost autonomous handling too, not only Sol sessions. Real sends only — a
  // sandbox draft already returned above. `sol_handled_at` stays the Sol-specific sub-flag.
  await admin.from("tickets").update({ ai_handled_at: new Date().toISOString() }).eq("id", ticketId);

  const stampResend = async (messageId: string) => {
    await admin
      .from("ticket_messages")
      .update({ resend_email_id: messageId, email_status: "sent" })
      .eq("ticket_id", ticketId)
      .eq("direction", "outbound")
      .is("resend_email_id", null)
      .order("created_at", { ascending: false })
      .limit(1);
  };

  if (channel === "email" && t?.customer_id) {
    const { data: cust } = await admin.from("customers").select("email").eq("id", t.customer_id).single();
    if (cust?.email) {
      const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspaceId).single();
      const res = await sendTicketReply({
        workspaceId,
        toEmail: cust.email,
        subject: `Re: ${t.subject || "Your request"}`,
        body: html,
        inReplyTo: t.email_message_id || null,
        agentName: "Support",
        workspaceName: ws?.name || "",
      });
      if (res.messageId) {
        await admin
          .from("ticket_messages")
          .update({ resend_email_id: res.messageId, email_status: "sent", email_message_id: `<${res.messageId}@resend.dev>` })
          .eq("ticket_id", ticketId)
          .eq("direction", "outbound")
          .is("resend_email_id", null)
          .order("created_at", { ascending: false })
          .limit(1);
      }
    }
    return;
  }

  // Portal: always email the customer the thread (most-recent-on-top), same as
  // the orchestrator. The portal UI shows the thread too, but the customer
  // isn't necessarily watching it, so email is the guaranteed delivery.
  if (channel === "portal") {
    const { sendPortalThreadEmail } = await import("@/lib/portal/portal-thread-email");
    const msgId = await sendPortalThreadEmail(admin, workspaceId, ticketId);
    if (msgId) await stampResend(msgId);
    return;
  }

  // Chat→email fallback: if the chat customer has gone idle, also send the
  // message via email so it isn't stranded in a widget they've closed.
  if (channel === "chat" && t?.customer_id) {
    const { getDeliveryChannel } = await import("@/lib/delivery-channel");
    const effectiveCh = await getDeliveryChannel(ticketId, channel);
    if (effectiveCh === "email") {
      const { data: cust } = await admin.from("customers").select("email").eq("id", t.customer_id).single();
      if (cust?.email) {
        const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspaceId).single();
        const res = await sendTicketReply({
          workspaceId,
          toEmail: cust.email,
          subject: `Re: ${t.subject || "Your chat with us"}`,
          body: html,
          inReplyTo: null,
          agentName: "Support",
          workspaceName: ws?.name || "",
        });
        if (res.messageId) {
          await admin.from("tickets").update({ email_message_id: `<${res.messageId}@resend.dev>` }).eq("id", ticketId);
          await stampResend(res.messageId);
        }
      }
    }
    // Pure-chat (not idle): the inserted row is delivered by the widget poll. No-op here.
  }
}
