import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

// GET — list available Slack targets (members + channels)
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  void request;
  const { id: ticketId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Get ticket workspace
  const { data: ticket } = await admin.from("tickets")
    .select("workspace_id")
    .eq("id", ticketId).single();
  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get workspace Slack config
  const { data: ws } = await admin.from("workspaces")
    .select("slack_bot_token_encrypted, slack_team_name")
    .eq("id", ticket.workspace_id).single();

  const slackConnected = !!ws?.slack_bot_token_encrypted;

  // Get team members with Slack user IDs
  const { data: members } = await admin.from("workspace_members")
    .select("user_id, display_name, slack_user_id")
    .eq("workspace_id", ticket.workspace_id);

  const slackMembers = (members || [])
    .filter(m => m.slack_user_id && m.user_id !== user.id)
    .map(m => ({ userId: m.user_id, name: m.display_name || "Team Member", slackUserId: m.slack_user_id }));

  // Get Slack channels if connected
  let slackChannels: { id: string; name: string }[] = [];
  if (slackConnected) {
    try {
      const token = decrypt(ws!.slack_bot_token_encrypted!);
      const res = await fetch("https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.ok) {
        slackChannels = (data.channels || [])
          .map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))
          .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
      }
    } catch { /* non-fatal */ }
  }

  return NextResponse.json({
    slackConnected,
    slackTeamName: ws?.slack_team_name || null,
    members: slackMembers,
    channels: slackChannels,
  });
}

// POST — share ticket via Slack DM or channel
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: ticketId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();
  const { target, message, mentionUserIds } = body as { target: string; message?: string; mentionUserIds?: string[] };

  if (!target) return NextResponse.json({ error: "target required" }, { status: 400 });

  // Get ticket + customer info
  const { data: ticket } = await admin.from("tickets")
    .select("workspace_id, subject, status, channel, customer_id, customers(first_name, last_name, email)")
    .eq("id", ticketId).single();
  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get sharer's display name
  const { data: sharer } = await admin.from("workspace_members")
    .select("display_name")
    .eq("workspace_id", ticket.workspace_id)
    .eq("user_id", user.id).single();
  const sharerName = sharer?.display_name || "Someone";

  // Get Slack token
  const { data: ws } = await admin.from("workspaces")
    .select("slack_bot_token_encrypted")
    .eq("id", ticket.workspace_id).single();
  if (!ws?.slack_bot_token_encrypted) {
    return NextResponse.json({ error: "Slack not connected" }, { status: 400 });
  }
  const token = decrypt(ws.slack_bot_token_encrypted);

  const customerArr = ticket.customers as unknown as { first_name: string; last_name: string; email: string }[] | null;
  const customer = customerArr?.[0] || null;
  const customerName = customer ? `${customer.first_name} ${customer.last_name}`.trim() || customer.email : "Unknown";
  const ticketUrl = `${process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai"}/dashboard/tickets/${ticketId}`;

  // Build Slack message blocks
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${sharerName}* shared a ticket with you`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Subject:*\n${ticket.subject || "No subject"}` },
        { type: "mrkdwn", text: `*Status:*\n${ticket.status}` },
        { type: "mrkdwn", text: `*Customer:*\n${customerName}` },
        { type: "mrkdwn", text: `*Channel:*\n${ticket.channel}` },
      ],
    },
  ];

  if (message?.trim()) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `💬 _"${message.trim()}"_` },
      fields: undefined as never,
    });
  }

  // Add mentions for channel shares
  if (mentionUserIds?.length) {
    const mentions = mentionUserIds.map(id => `<@${id}>`).join(" ");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: mentions },
      fields: undefined as never,
    });
  }

  blocks.push({
    type: "actions",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elements: [
      { type: "button", text: { type: "plain_text", text: "View Ticket" }, url: ticketUrl, style: "primary" },
    ],
  } as never);

  // Determine if target is a channel or user
  const isChannel = target.startsWith("C") || target.startsWith("G");
  let channelId = target;

  // If user, open a DM conversation first
  if (!isChannel) {
    const openRes = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ users: target }),
    });
    const openData = await openRes.json();
    if (!openData.ok) {
      return NextResponse.json({ error: `Slack DM failed: ${openData.error}` }, { status: 500 });
    }
    channelId = openData.channel.id;
  }

  // Send the message
  const sendRes = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: channelId,
      text: `${sharerName} shared a ticket: ${ticket.subject || "No subject"} — ${ticketUrl}`,
      blocks,
      unfurl_links: false,
    }),
  });
  const sendData = await sendRes.json();

  if (!sendData.ok) {
    return NextResponse.json({ error: `Slack send failed: ${sendData.error}` }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
