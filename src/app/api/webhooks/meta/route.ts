import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { verifyMetaWebhookSignature } from "@/lib/meta";
import { ingestSocialComment } from "@/lib/social-comment-ingest";

// GET: Meta webhook verification (hub.verify_token challenge).
//
// Meta sends this once when an admin subscribes the webhook in the
// App Dashboard. Verify token is per-page (on meta_pages) once
// multi-page is wired up; for now we still check the workspace-level
// token first, then fall back to any meta_pages row matching the token.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !token || !challenge) {
    return NextResponse.json({ error: "Invalid verification request" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Legacy single-page workspaces still verify off workspaces.meta_webhook_verify_token.
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id")
    .eq("meta_webhook_verify_token", token)
    .maybeSingle();

  if (!workspace) {
    // Per-page tokens — once a workspace has connected via the new
    // multi-page flow, every meta_pages row gets its own verify token.
    const { data: page } = await admin
      .from("meta_pages")
      .select("id")
      .eq("webhook_verify_token", token)
      .maybeSingle();
    if (!page) {
      return NextResponse.json({ error: "Invalid verify token" }, { status: 403 });
    }
  }

  return new Response(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

interface MetaMessagingEntry {
  id: string;                                  // page ID (FB) or IG Business ID
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
    field: string;                             // 'feed' (FB) | 'comments' (IG) | 'messages' | 'mention' | …
    value: MetaChangeValue;
  }>;
}

interface MetaChangeValue {
  from?: { id: string; name?: string; username?: string };
  item?: string;                               // 'comment' | 'post' | 'status'
  comment_id?: string;
  parent_id?: string;                          // present when this is a reply to another comment
  post_id?: string;
  message?: string;
  verb?: string;                               // 'add' | 'edited' | 'remove' | 'hide' | …
  created_time?: number;
  ad_id?: string;                              // present on ad-comment events
  // Instagram comments shape
  id?: string;                                 // IG comment ID
  media?: { id?: string; ad_id?: string };
}

interface MetaWebhookBody {
  object: string;                              // 'page' | 'instagram'
  entry: MetaMessagingEntry[];
}

// POST: Process incoming Meta webhook events.
//
// Two routing paths:
//   1. DMs (entry.messaging or change.field === 'messages')
//      → existing tickets flow, channel = 'meta_dm'. Unchanged.
//   2. Comments (change.field === 'feed' with item='comment', OR
//                change.field === 'comments' on Instagram)
//      → new social_comments table via ingestSocialComment().
//
// HMAC verification runs first on the raw request body. Without it
// any third party that learns our endpoint URL can spoof webhooks.
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");

  const signatureValid = verifyMetaWebhookSignature(rawBody, signatureHeader, process.env.META_APP_SECRET);

  let body: MetaWebhookBody;
  let parsed = false;
  try {
    body = JSON.parse(rawBody);
    parsed = true;
  } catch {
    body = { object: "", entry: [] };
  }

  const admin = createAdminClient();

  // Stash raw payload for debugging (every body, even invalid sig).
  // 7-day retention via cleanup cron — see meta_webhook_raw migration.
  //
  // Must AWAIT this — Vercel serverless terminates the function process
  // the instant we return a response. A fire-and-forget Promise gets
  // killed mid-flight before the Supabase fetch lands. Supabase insert
  // is ~50ms; Meta gives us 20s. Trivially within budget.
  try {
    await admin.from("meta_webhook_raw").insert({
      signature_valid: signatureValid,
      body: parsed ? body : { raw: rawBody.slice(0, 50000) },
      headers: Object.fromEntries(request.headers),
    });
  } catch (err) {
    console.error("meta_webhook_raw insert failed:", err);
  }

  if (!signatureValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  if (!parsed) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  for (const entry of body.entry || []) {
    const platformPageId = entry.id;

    // Resolve workspace from the meta_pages table first (multi-page)
    // and fall back to the legacy workspaces.meta_page_id column so
    // workspaces that haven't migrated keep working unchanged.
    const { data: page } = await admin
      .from("meta_pages")
      .select("id, workspace_id, page_type, ai_moderate_ad_comments, ai_moderate_organic_comments, platform")
      .eq("meta_page_id", platformPageId)
      .eq("is_active", true)
      .maybeSingle();

    let workspaceId: string | null = page?.workspace_id ?? null;
    if (!workspaceId) {
      const { data: legacyWorkspace } = await admin
        .from("workspaces")
        .select("id")
        .eq("meta_page_id", platformPageId)
        .maybeSingle();
      workspaceId = legacyWorkspace?.id ?? null;
    }

    if (!workspaceId) continue;

    // ── DMs (entry.messaging) — unchanged ────────────────────────
    if (entry.messaging) {
      for (const event of entry.messaging) {
        if (!event.message?.text) continue;

        const senderId = event.sender.id;
        if (senderId === platformPageId) continue;

        const messageText = event.message.text;
        const messageId = event.message.mid;

        const { data: existingTicket } = await admin
          .from("tickets")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("meta_sender_id", senderId)
          .eq("channel", "meta_dm")
          .in("status", ["open", "pending"])
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existingTicket) {
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

          await inngest.send({
            name: "ticket/inbound-message",
            data: {
              workspace_id: workspaceId,
              ticket_id: existingTicket.id,
              message_body: messageText,
              channel: "meta_dm",
              is_new_ticket: false,
            },
          });
        } else {
          const { data: ticket } = await admin.from("tickets").insert({
            workspace_id: workspaceId,
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

            await inngest.send({
              name: "ticket/inbound-message",
              data: {
                workspace_id: workspaceId,
                ticket_id: ticket.id,
                message_body: messageText,
                channel: "meta_dm",
                is_new_ticket: true,
              },
            });
          }
        }
      }
    }

    // ── Comments / feed changes → social_comments ────────────────
    if (entry.changes && page) {
      for (const change of entry.changes) {
        const isFbComment = change.field === "feed" && change.value.item === "comment";
        const isIgComment = change.field === "comments";
        if (!isFbComment && !isIgComment) continue;

        // Comments posted by the page itself are us — never moderate
        // our own outbound replies. Without this check the AI could
        // reply to its own reply, loop forever.
        const senderId = change.value.from?.id;
        if (!senderId || senderId === platformPageId) continue;

        await ingestSocialComment({
          admin,
          page,
          platform: body.object === "instagram" ? "instagram" : "facebook",
          change: change.value,
          changeField: change.field,
        });
      }
    }
  }

  // Meta expects 200 quickly — we don't await Inngest fan-out beyond
  // the send() enqueue.
  return NextResponse.json({ status: "ok" });
}
