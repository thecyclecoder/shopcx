/**
 * tickets-reply — the canonical way to send ONE customer-facing, THREADED reply on a ticket.
 *
 * Wraps [[ticket-delivery]] `deliverTicketMessage` (the production, portal-aware delivery sink) so
 * callers — Sol's cheap-execution, hand-fixes, the Improve executor — have one typed entry that
 * guarantees threading and returns a handle to what was sent.
 *
 * THREADING GUARANTEE (why this is a "threaded" reply, not just a send):
 *   - email: delivered via `sendTicketReply` with `inReplyTo = tickets.email_message_id`, and the
 *     reply's OWN Message-ID is stored back onto both the ticket message row (`email_message_id`)
 *     so the customer's next reply — which References that Message-ID — can be matched to THIS ticket
 *     instead of spawning a duplicate. (Inbound matching itself lives in the mail-ingest path; this
 *     SDK's job is to emit a correctly-threaded outbound so that matching is possible.)
 *   - portal: emailed via `sendPortalThreadEmail` (most-recent-on-top) + shown in the portal UI.
 *   - chat: delivered by the widget; idle chat falls back to a threaded email.
 *
 * Mini-site and live chat produce identical ticket messages (CLAUDE.md) because the body shaping +
 * per-channel handling all live inside `deliverTicketMessage`. Read-side inspection: [[tickets-read]].
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { deliverTicketMessage } from "@/lib/ticket-delivery";

type Admin = ReturnType<typeof createAdminClient>;

export interface SendThreadedReplyArgs {
  workspaceId: string;
  ticketId: string;
  /** plain-text reply (no markdown; paragraphs split on blank lines — the sink shapes to HTML). */
  message: string;
  /** override the delivery channel; defaults to the ticket's own `channel`. */
  channel?: string;
  /** sandbox mode logs an internal AI-draft and delivers nothing. */
  sandbox?: boolean;
}

export interface ThreadedReplyResult {
  /** id of the inserted ticket_messages row (null in sandbox / if it couldn't be re-read). */
  ticketMessageId: string | null;
  /** the Resend/provider message id, when the outbound actually shipped. */
  providerMessageId: string | null;
  /** true when a real (non-sandbox) message was inserted + delivery attempted. */
  delivered: boolean;
  sandbox: boolean;
}

/**
 * Send one threaded, customer-facing reply on a ticket. Resolves the channel from the ticket when not
 * given, delivers through the production sink, then re-reads the inserted outbound row so the caller
 * gets its id + provider message id (deliverTicketMessage itself returns void).
 */
export async function sendThreadedReply(admin: Admin, args: SendThreadedReplyArgs): Promise<ThreadedReplyResult> {
  const { workspaceId, ticketId, message, sandbox = false } = args;
  if (!message || !message.trim()) throw new Error("sendThreadedReply: empty message");

  let channel = args.channel;
  if (!channel) {
    const { data } = await admin.from("tickets").select("channel").eq("id", ticketId).single();
    channel = (data?.channel as string | null) || "email";
  }

  await deliverTicketMessage(admin, workspaceId, ticketId, channel, message, sandbox);

  // Re-read the just-inserted outbound row (visibility differs: sandbox → internal draft).
  const { data: row } = await admin
    .from("ticket_messages")
    .select("id, resend_email_id, visibility, sent_at")
    .eq("ticket_id", ticketId)
    .eq("author_type", "ai")
    .eq("visibility", sandbox ? "internal" : "external")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    ticketMessageId: (row?.id as string) ?? null,
    providerMessageId: (row?.resend_email_id as string | null) ?? null,
    delivered: !sandbox && !!row?.sent_at,
    sandbox,
  };
}
