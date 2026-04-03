import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// GET: Meta webhook verification (hub.verify_token challenge)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !token || !challenge) {
    return NextResponse.json({ error: "Invalid verification request" }, { status: 400 });
  }

  // Look up workspace by verify token
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id")
    .eq("meta_webhook_verify_token", token)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Invalid verify token" }, { status: 403 });
  }

  // Return the challenge to confirm subscription
  return new Response(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

interface MetaMessagingEntry {
  id: string; // page ID
  time: number;
  messaging?: Array<{
    sender: { id: string };
    recipient: { id: string };
    timestamp: number;
    message?: {
      mid: string;
      text?: string;
      attachments?: Array<{ type: string; payload: { url: string } }>;
    };
  }>;
  changes?: Array<{
    field: string;
    value: {
      from: { id: string; name?: string };
      item: string; // "comment" | "post" | "status"
      comment_id?: string;
      post_id?: string;
      message?: string;
      verb: string; // "add" | "edited" | "remove"
      created_time: number;
    };
  }>;
}

interface MetaWebhookBody {
  object: string;
  entry: MetaMessagingEntry[];
}

// POST: Process incoming Meta messages and comments
export async function POST(request: Request) {
  let body: MetaWebhookBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Meta expects 200 quickly; process async
  const admin = createAdminClient();

  for (const entry of body.entry || []) {
    const pageId = entry.id;

    // Find workspace by page ID
    const { data: workspace } = await admin
      .from("workspaces")
      .select("id, meta_page_id")
      .eq("meta_page_id", pageId)
      .single();

    if (!workspace) continue;

    // Handle DMs (messaging field)
    if (entry.messaging) {
      for (const event of entry.messaging) {
        if (!event.message?.text) continue;

        const senderId = event.sender.id;
        // Skip messages sent by the page itself
        if (senderId === pageId) continue;

        const messageText = event.message.text;
        const messageId = event.message.mid;

        // Check for existing open ticket from this sender
        const { data: existingTicket } = await admin
          .from("tickets")
          .select("id")
          .eq("workspace_id", workspace.id)
          .eq("meta_sender_id", senderId)
          .eq("channel", "meta_dm")
          .in("status", ["open", "pending"])
          .order("updated_at", { ascending: false })
          .limit(1)
          .single();

        if (existingTicket) {
          // Thread into existing ticket
          await admin.from("ticket_messages").insert({
            ticket_id: existingTicket.id,
            direction: "inbound",
            visibility: "external",
            author_type: "customer",
            body: messageText,
            meta_message_id: messageId,
          });

          await admin.from("tickets").update({
            status: "open",
            updated_at: new Date().toISOString(),
            last_customer_reply_at: new Date().toISOString(),
          }).eq("id", existingTicket.id);

          // Trigger unified handler
          await inngest.send({
            name: "ticket/inbound-message",
            data: { workspace_id: workspace.id, ticket_id: existingTicket.id, message_body: messageText, channel: "meta_dm", is_new_ticket: false },
          });
        } else {
          // Create new ticket
          const { data: ticket } = await admin.from("tickets").insert({
            workspace_id: workspace.id,
            channel: "meta_dm",
            status: "open",
            subject: `DM from ${senderId}`,
            meta_sender_id: senderId,
            last_customer_reply_at: new Date().toISOString(),
          }).select("id").single();

          if (ticket) {
            await admin.from("ticket_messages").insert({
              ticket_id: ticket.id,
              direction: "inbound",
              visibility: "external",
              author_type: "customer",
              body: messageText,
              meta_message_id: messageId,
            });

            // Trigger unified handler
            await inngest.send({
              name: "ticket/inbound-message",
              data: { workspace_id: workspace.id, ticket_id: ticket.id, message_body: messageText, channel: "meta_dm", is_new_ticket: true },
            });
          }
        }
      }
    }

    // Handle comments/feed changes
    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field !== "feed") continue;
        if (change.value.verb !== "add") continue;
        if (change.value.item !== "comment") continue;

        const senderId = change.value.from.id;
        const senderName = change.value.from.name || senderId;
        // Skip comments from the page itself
        if (senderId === pageId) continue;

        const commentId = change.value.comment_id;
        const postId = change.value.post_id;
        const commentText = change.value.message || "";

        if (!commentText || !commentId) continue;

        // Create a ticket for the comment
        const { data: ticket } = await admin.from("tickets").insert({
          workspace_id: workspace.id,
          channel: "social_comments",
          status: "open",
          subject: `Comment from ${senderName} on post`,
          meta_sender_id: senderId,
          meta_comment_id: commentId,
          meta_post_id: postId,
          last_customer_reply_at: new Date().toISOString(),
        }).select("id").single();

        if (ticket) {
          await admin.from("ticket_messages").insert({
            ticket_id: ticket.id,
            direction: "inbound",
            visibility: "external",
            author_type: "customer",
            body: commentText,
            meta_message_id: commentId,
          });

          // Trigger unified handler (social comments = macro only)
          await inngest.send({
            name: "ticket/inbound-message",
            data: { workspace_id: workspace.id, ticket_id: ticket.id, message_body: commentText, channel: "social_comments", is_new_ticket: true },
          });
        }
      }
    }
  }

  return NextResponse.json({ status: "ok" });
}
