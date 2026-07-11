import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyMetaWebhookSignature } from "@/lib/meta";
import { ingestSocialComment } from "@/lib/social-comment-ingest";
import { dispatchInboundMessage } from "@/lib/inngest/dispatch-inbound-message";

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
      .select("id, workspace_id, meta_page_id, page_type, ai_moderate_ad_comments, ai_moderate_organic_comments, platform")
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
          const { data: metaExistingMsg } = await admin.from("ticket_messages").insert({
            ticket_id: existingTicket.id,
            direction: "inbound",
            visibility: "external",
            author_type: "customer",
            body: messageText,
            meta_message_id: messageId,
          }).select("id").single();

          await admin.from("tickets").update({
            status: "open",
            updated_at: new Date().toISOString(),
            last_customer_reply_at: new Date().toISOString(),
          }).eq("id", existingTicket.id);

          await dispatchInboundMessage({
            admin,
            workspaceId,
            ticketId: existingTicket.id,
            messageBody: messageText,
            channel: "meta_dm",
            isNewTicket: false,
            dispatchMessageId: metaExistingMsg?.id ?? null,
          });
        } else {
          // Meta DMs arrive with just a PSID — no name, no email.
          //
          // Customer resolution policy for meta_dm:
          //   1. Confirmed binding in meta_sender_customer_links → use it.
          //   2. Otherwise leave customer_id = NULL. The orchestrator
          //      asks for email or order number when the intent is
          //      account-related, and auto-link-customer-from-message
          //      proposes the link on the next inbound.
          //
          // DO NOT fuzzy-match by first+last name here. Common names
          // (6 Susan Smiths in the customers table) make name-only
          // matching unsafe for a direct conversation — name fuzzy
          // matching is a social-comments heuristic, not a DM one.
          //
          // We still call Graph for the name so the ticket subject reads
          // "DM from Jane Doe" instead of "DM from 3470392026374637".
          let senderFirstName: string | null = null;
          let senderLastName: string | null = null;
          let matchedCustomerId: string | null = null;

          const { data: confirmedLink } = await admin
            .from("meta_sender_customer_links")
            .select("customer_id, meta_sender_name")
            .eq("workspace_id", workspaceId)
            .eq("meta_sender_id", senderId)
            .maybeSingle();
          if (confirmedLink?.customer_id) {
            matchedCustomerId = confirmedLink.customer_id;
            const linkName = (confirmedLink.meta_sender_name || "").trim().split(/\s+/);
            if (linkName.length >= 1) senderFirstName = linkName[0] || null;
            if (linkName.length >= 2) senderLastName = linkName.slice(1).join(" ") || null;
          }

          // Graph API name fetch (for subject). PSIDs are PAGE-SCOPED —
          // only the recipient page's token can resolve them. Pull from
          // meta_pages keyed by platformPageId (the page the DM was sent
          // to). Legacy single-page workspaces fall back to the
          // workspace-level token.
          try {
            const { data: pageRow } = await admin
              .from("meta_pages")
              .select("access_token_encrypted")
              .eq("workspace_id", workspaceId)
              .eq("meta_page_id", platformPageId)
              .maybeSingle();
            let enc: string | null = (pageRow?.access_token_encrypted as string | null) || null;
            if (!enc) {
              const { data: wsRow } = await admin
                .from("workspaces")
                .select("meta_page_access_token_encrypted")
                .eq("id", workspaceId).single();
              enc = (wsRow?.meta_page_access_token_encrypted as string | null) || null;
            }
            if (enc) {
              const { decrypt } = await import("@/lib/crypto");
              const { fetchMessengerUserProfile } = await import("@/lib/meta");
              const profile = await fetchMessengerUserProfile(decrypt(enc), senderId);
              if (profile) {
                senderFirstName = profile.first_name || senderFirstName;
                senderLastName = profile.last_name || senderLastName;
              }
            }
          } catch (err) {
            console.warn(`[meta-dm] sender enrichment failed for ${senderId}:`, err);
          }

          const fullName = [senderFirstName, senderLastName].filter(Boolean).join(" ").trim();
          const subject = fullName ? `DM from ${fullName}` : `DM from ${senderId}`;

          const { data: ticket } = await admin.from("tickets").insert({
            workspace_id: workspaceId,
            channel: "meta_dm",
            status: "open",
            subject,
            meta_sender_id: senderId,
            customer_id: matchedCustomerId,
            last_customer_reply_at: new Date().toISOString(),
          }).select("id").single();

          if (ticket) {
            const { data: metaNewMsg } = await admin.from("ticket_messages").insert({
              ticket_id: ticket.id,
              direction: "inbound",
              visibility: "external",
              author_type: "customer",
              body: messageText,
              meta_message_id: messageId,
            }).select("id").single();

            await dispatchInboundMessage({
              admin,
              workspaceId,
              ticketId: ticket.id,
              messageBody: messageText,
              channel: "meta_dm",
              isNewTicket: true,
              dispatchMessageId: metaNewMsg?.id ?? null,
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
