// Slack API client — bot token per workspace, Block Kit message builders

import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt, decrypt } from "@/lib/crypto";

const SLACK_API = "https://slack.com/api";

// ── Credentials ──

export async function getSlackToken(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("slack_bot_token_encrypted")
    .eq("id", workspaceId)
    .single();
  if (!data?.slack_bot_token_encrypted) return null;
  return decrypt(data.slack_bot_token_encrypted);
}

export async function isSlackConnected(workspaceId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("slack_bot_token_encrypted")
    .eq("id", workspaceId)
    .single();
  return !!data?.slack_bot_token_encrypted;
}

// ── Core API calls ──

async function slackApi(token: string, method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<Record<string, unknown>>;
}

export async function postMessage(
  token: string,
  channel: string,
  blocks: unknown[],
  text: string,
): Promise<boolean> {
  const result = await slackApi(token, "chat.postMessage", { channel, blocks, text });
  if (!result.ok) {
    console.error("[Slack] postMessage error:", result.error);
    return false;
  }
  return true;
}

export async function lookupUserByEmail(token: string, email: string): Promise<string | null> {
  const result = await slackApi(token, "users.lookupByEmail", { email });
  if (!result.ok) return null;
  return (result.user as { id: string })?.id || null;
}

export async function listChannels(token: string): Promise<{ id: string; name: string }[]> {
  const channels: { id: string; name: string }[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      types: "public_channel",
      exclude_archived: true,
      limit: 200,
    };
    if (cursor) body.cursor = cursor;

    const result = await slackApi(token, "conversations.list", body);
    if (!result.ok) break;

    const items = (result.channels as { id: string; name: string }[]) || [];
    channels.push(...items.map((c) => ({ id: c.id, name: c.name })));

    cursor = (result.response_metadata as { next_cursor?: string })?.next_cursor || undefined;
  } while (cursor);

  return channels;
}

// ── Team member auto-mapping ──

export async function autoMapTeamMembers(workspaceId: string): Promise<{ mapped: number; total: number }> {
  const token = await getSlackToken(workspaceId);
  if (!token) return { mapped: 0, total: 0 };

  const admin = createAdminClient();
  const { data: members } = await admin
    .from("workspace_members")
    .select("id, user_id")
    .eq("workspace_id", workspaceId);

  if (!members?.length) return { mapped: 0, total: 0 };

  // Get emails from auth.users
  let mapped = 0;
  for (const member of members) {
    const { data: userData } = await admin.auth.admin.getUserById(member.user_id);
    const email = userData?.user?.email;
    if (!email) continue;

    const slackUserId = await lookupUserByEmail(token, email);
    if (slackUserId) {
      await admin
        .from("workspace_members")
        .update({ slack_user_id: slackUserId })
        .eq("id", member.id);
      mapped++;
    }
  }

  return { mapped, total: members.length };
}

// ── OAuth helpers ──

export async function exchangeCodeForToken(code: string): Promise<{
  ok: boolean;
  access_token?: string;
  team?: { id: string; name: string };
  error?: string;
}> {
  const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID || "",
      client_secret: process.env.SLACK_CLIENT_SECRET || "",
      code,
    }),
  });
  return res.json() as Promise<{
    ok: boolean;
    access_token?: string;
    team?: { id: string; name: string };
    error?: string;
  }>;
}

export async function saveSlackConnection(
  workspaceId: string,
  botToken: string,
  teamId: string,
  teamName: string,
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("workspaces")
    .update({
      slack_bot_token_encrypted: encrypt(botToken),
      slack_team_id: teamId,
      slack_team_name: teamName,
      slack_connected_at: new Date().toISOString(),
    })
    .eq("id", workspaceId);
}

export async function disconnectSlack(workspaceId: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("workspaces")
    .update({
      slack_bot_token_encrypted: null,
      slack_team_id: null,
      slack_team_name: null,
      slack_connected_at: null,
    })
    .eq("id", workspaceId);

  await admin
    .from("workspace_members")
    .update({ slack_user_id: null })
    .eq("workspace_id", workspaceId);
}

// ── Block Kit message builders ──

function ticketLink(ticketId: string): string {
  return `https://shopcx.ai/dashboard/tickets/${ticketId}`;
}

function customerLine(customer: { name?: string; email?: string }): string {
  const parts = [customer.name, customer.email].filter(Boolean);
  return parts.join(" — ") || "Unknown customer";
}

function headerBlock(emoji: string, title: string): unknown {
  return {
    type: "header",
    text: { type: "plain_text", text: `${emoji} ${title}`, emoji: true },
  };
}

function sectionBlock(text: string): unknown {
  return {
    type: "section",
    text: { type: "mrkdwn", text },
  };
}

function dividerBlock(): unknown {
  return { type: "divider" };
}

function actionsBlock(ticketId: string): unknown {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View in ShopCX" },
        url: ticketLink(ticketId),
        action_id: "view_ticket",
      },
    ],
  };
}

export function buildEscalationMessage(data: {
  ticketId: string;
  ticketNumber?: string;
  customer: { name?: string; email?: string };
  reason: string;
  assignedTo?: string;
}): { blocks: unknown[]; text: string } {
  const text = `Ticket ${data.ticketNumber || data.ticketId} escalated: ${data.reason}`;
  const blocks = [
    headerBlock("🚨", "Ticket Escalated"),
    sectionBlock(
      `*Customer:* ${customerLine(data.customer)}\n` +
      `*Reason:* ${data.reason}\n` +
      (data.assignedTo ? `*Assigned to:* ${data.assignedTo}\n` : "") +
      (data.ticketNumber ? `*Ticket:* ${data.ticketNumber}` : "")
    ),
    dividerBlock(),
    actionsBlock(data.ticketId),
  ];
  return { blocks, text };
}

export function buildChargebackMessage(data: {
  ticketId?: string;
  customer: { name?: string; email?: string };
  amount: string;
  reason: string;
  orderId?: string;
}): { blocks: unknown[]; text: string } {
  const text = `Chargeback received: ${data.amount} from ${data.customer.email}`;
  const blocks = [
    headerBlock("💳", "Chargeback Received"),
    sectionBlock(
      `*Customer:* ${customerLine(data.customer)}\n` +
      `*Amount:* ${data.amount}\n` +
      `*Reason:* ${data.reason}\n` +
      (data.orderId ? `*Order:* ${data.orderId}` : "")
    ),
    dividerBlock(),
    ...(data.ticketId ? [actionsBlock(data.ticketId)] : []),
  ];
  return { blocks, text };
}

export function buildFraudMessage(data: {
  customer: { name?: string; email?: string };
  severity: string;
  rules: string[];
  caseId?: string;
}): { blocks: unknown[]; text: string } {
  const text = `Fraud case detected: ${data.severity} severity for ${data.customer.email}`;
  const blocks = [
    headerBlock("🛑", "Fraud Case Detected"),
    sectionBlock(
      `*Customer:* ${customerLine(data.customer)}\n` +
      `*Severity:* ${data.severity}\n` +
      `*Rules triggered:* ${data.rules.join(", ")}`
    ),
    dividerBlock(),
  ];
  return { blocks, text };
}

export function buildDunningMessage(data: {
  customer: { name?: string; email?: string };
  subscriptionId?: string;
  attempts: number;
  ticketId?: string;
}): { blocks: unknown[]; text: string } {
  const text = `Dunning failed for ${data.customer.email} after ${data.attempts} attempts`;
  const blocks = [
    headerBlock("⚠️", "Dunning Failed"),
    sectionBlock(
      `*Customer:* ${customerLine(data.customer)}\n` +
      `*Attempts:* ${data.attempts}\n` +
      `All payment methods exhausted.`
    ),
    dividerBlock(),
    ...(data.ticketId ? [actionsBlock(data.ticketId)] : []),
  ];
  return { blocks, text };
}

export function buildCsatMessage(data: {
  ticketId: string;
  ticketNumber?: string;
  customer: { name?: string; email?: string };
  score: number;
  comment?: string;
}): { blocks: unknown[]; text: string } {
  const text = `Negative CSAT from ${data.customer.email}: ${data.score}/5`;
  const blocks = [
    headerBlock("😞", "Negative CSAT Response"),
    sectionBlock(
      `*Customer:* ${customerLine(data.customer)}\n` +
      `*Score:* ${data.score}/5\n` +
      (data.comment ? `*Comment:* "${data.comment}"\n` : "") +
      (data.ticketNumber ? `*Ticket:* ${data.ticketNumber}` : "")
    ),
    dividerBlock(),
    actionsBlock(data.ticketId),
  ];
  return { blocks, text };
}

export function buildCancelMessage(data: {
  ticketId?: string;
  customer: { name?: string; email?: string };
  reason?: string;
}): { blocks: unknown[]; text: string } {
  const text = `Subscription cancelled by ${data.customer.email}`;
  const blocks = [
    headerBlock("❌", "Subscription Cancelled"),
    sectionBlock(
      `*Customer:* ${customerLine(data.customer)}\n` +
      (data.reason ? `*Reason:* ${data.reason}` : "")
    ),
    dividerBlock(),
    ...(data.ticketId ? [actionsBlock(data.ticketId)] : []),
  ];
  return { blocks, text };
}

export function buildNewTicketMessage(data: {
  ticketId: string;
  ticketNumber?: string;
  customer: { name?: string; email?: string };
  channel: string;
  subject?: string;
}): { blocks: unknown[]; text: string } {
  const text = `New ticket from ${data.customer.email} via ${data.channel}`;
  const blocks = [
    headerBlock("📩", "New Ticket"),
    sectionBlock(
      `*Customer:* ${customerLine(data.customer)}\n` +
      `*Channel:* ${data.channel}\n` +
      (data.subject ? `*Subject:* ${data.subject}\n` : "") +
      (data.ticketNumber ? `*Ticket:* ${data.ticketNumber}` : "")
    ),
    dividerBlock(),
    actionsBlock(data.ticketId),
  ];
  return { blocks, text };
}
