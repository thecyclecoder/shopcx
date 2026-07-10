// Slack API client — bot token per workspace, Block Kit message builders

import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt, decrypt } from "@/lib/crypto";
import { getPersona } from "@/lib/agents/personas";

const SLACK_API = "https://slack.com/api";

// Ada's per-message Slack identity (chat:write.customize). The one bot speaks AS Ada — her name +
// her real avatar — ONLY when a caller opts in via postAsAda; every other message stays "shopcx".
// Sourced from personas.ts so the name/avatar never drift from the rest of the app (ada-slack-chat).
const ADA = getPersona("platform");
export const ADA_SLACK_IDENTITY = { username: ADA.name, icon_url: ADA.avatarUrl };

// ── Fetch hardening ──
// Per-request hard cap so one slow/hung Slack endpoint can't wedge a caller —
// notably the per-minute slack-roadmap-notify cron — past Inngest's execution
// budget. On timeout `fetch` rejects with a TimeoutError, which propagates to
// the caller's try/catch (a thrown Slack error still lets the cron heartbeat
// fire). A transient blip costs one slow tick, never an open-ended freeze.
const SLACK_TIMEOUT_MS = 5000;
// Bounded retries on HTTP 429, honoring a capped Retry-After. A rate-limit
// costs at most a few short waits, never an unbounded back-off.
const SLACK_MAX_RETRIES = 2;
const SLACK_MAX_RETRY_WAIT_MS = 3000;
// Pagination guard for conversations.list / users.conversations so a cursor
// that never empties (or a huge workspace) can't loop fetches unbounded.
const SLACK_MAX_PAGES = 20;

/**
 * `fetch` wrapper for every Slack API call: a hard per-request timeout plus a
 * bounded, Retry-After-honoring retry on HTTP 429. Throws on timeout/network
 * error so the caller fails fast instead of hanging.
 */
async function slackFetch(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SLACK_TIMEOUT_MS) });
    if (res.status !== 429 || attempt >= SLACK_MAX_RETRIES) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Math.min(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000,
      SLACK_MAX_RETRY_WAIT_MS,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

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
  const res = await slackFetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<Record<string, unknown>>;
}

// Control Tower — ONE monitor for ALL Slack comms (replaces per-channel cron monitors). Every successful
// chat.postMessage beats the `slack-delivery` loop; a sustained delivery outage (revoked token / Slack down)
// stops the beats and the monitor flags it after the liveness window. The daily digest alone guarantees a
// beat every ~24h, so a red here means Slack genuinely isn't delivering — not "this one channel was quiet."
// Throttled (≤1 beat / 5 min) + fire-and-forget so it never adds latency or row-spam to the hot send path.
let lastSlackBeatMs = 0;
function beatSlackDelivery(channel: string): void {
  const now = Date.now();
  if (now - lastSlackBeatMs < 5 * 60_000) return;
  lastSlackBeatMs = now;
  void (async () => {
    try {
      const { emitLoopHeartbeat } = await import("@/lib/control-tower/heartbeat");
      await emitLoopHeartbeat("slack-delivery", "reactive", { ok: true, detail: `delivered → ${channel}` });
    } catch {
      /* best-effort — a heartbeat write must never affect the send */
    }
  })();
}

export async function postMessage(
  token: string,
  channel: string,
  blocks: unknown[],
  text: string,
  opts?: { thread_ts?: string },
): Promise<boolean> {
  const body: Record<string, unknown> = { channel, blocks, text };
  if (opts?.thread_ts) body.thread_ts = opts.thread_ts;
  const result = await slackApi(token, "chat.postMessage", body);
  if (!result.ok) {
    console.error("[Slack] postMessage error:", result.error);
    return false;
  }
  beatSlackDelivery(channel);
  return true;
}

/**
 * Post a message AS Ada (her name + avatar, via the chat:write.customize override) — used only by the
 * #cto-ada chat (ada-slack-chat). Returns the posted message `ts` so the caller can chat.update it later
 * (e.g. resolve an approval card). `blocks` may be empty for a plain-text reply (Ada's voice is plain text).
 * `opts.thread_ts` keeps the reply inside the founder's Slack thread so a reply to it continues the convo.
 */
export async function postAsAda(
  token: string,
  channel: string,
  blocks: unknown[],
  text: string,
  opts?: { thread_ts?: string },
): Promise<{ ok: boolean; ts?: string }> {
  const body: Record<string, unknown> = { channel, text, ...ADA_SLACK_IDENTITY };
  if (blocks.length) body.blocks = blocks;
  if (opts?.thread_ts) body.thread_ts = opts.thread_ts;
  const result = await slackApi(token, "chat.postMessage", body);
  if (!result.ok) {
    console.error("[Slack] postAsAda error:", result.error);
    return { ok: false };
  }
  beatSlackDelivery(channel);
  return { ok: true, ts: result.ts as string };
}

// Growth Director (Max) identity — the media-buyer digest posts into #director-growth-max AS Max, mirroring
// how Ada posts into #cto-ada. Sourced from personas.ts so name/avatar never drift (media-buyer-director-slack-digest).
const MAX = getPersona("growth");
export const GROWTH_DIRECTOR_SLACK_IDENTITY = { username: MAX.name, icon_url: MAX.avatarUrl };

/**
 * Post a message AS the Growth Director (Max's name + avatar, chat:write.customize override) — used by the
 * media-buyer director digest into the founder's #director-growth-max channel (media-buyer-director-slack-digest
 * Phase 2). Parallel of {@link postAsAda}; returns the posted `ts`.
 */
export async function postAsGrowthDirector(
  token: string,
  channel: string,
  blocks: unknown[],
  text: string,
  opts?: { thread_ts?: string },
): Promise<{ ok: boolean; ts?: string }> {
  const body: Record<string, unknown> = { channel, text, ...GROWTH_DIRECTOR_SLACK_IDENTITY };
  if (blocks.length) body.blocks = blocks;
  if (opts?.thread_ts) body.thread_ts = opts.thread_ts;
  const result = await slackApi(token, "chat.postMessage", body);
  if (!result.ok) {
    console.error("[Slack] postAsGrowthDirector error:", result.error);
    return { ok: false };
  }
  beatSlackDelivery(channel);
  return { ok: true, ts: result.ts as string };
}

/** Add an emoji reaction to a message (reactions.add) — the 👀 "received, thinking" ack in #cto-ada. */
export async function addReaction(token: string, channel: string, ts: string, name: string): Promise<boolean> {
  const result = await slackApi(token, "reactions.add", { channel, timestamp: ts, name });
  // already_reacted is a benign no-op (Slack retried the event); don't log it as an error.
  if (!result.ok && result.error !== "already_reacted") {
    console.error("[Slack] addReaction error:", result.error);
    return false;
  }
  return true;
}

/** Open a modal (views.open). `view` is a Block Kit view object. Returns ok. */
export async function openModal(token: string, triggerId: string, view: unknown): Promise<boolean> {
  const result = await slackApi(token, "views.open", { trigger_id: triggerId, view });
  if (!result.ok) {
    console.error("[Slack] openModal error:", result.error);
    return false;
  }
  return true;
}

/** Update an open modal in place (views.update) — used to reflect an action taken from inside the modal. */
export async function updateModal(token: string, viewId: string, view: unknown): Promise<boolean> {
  const result = await slackApi(token, "views.update", { view_id: viewId, view });
  if (!result.ok) {
    console.error("[Slack] updateModal error:", result.error);
    return false;
  }
  return true;
}

/** Publish an App Home tab view for a user (views.publish). `view` is a Block Kit `home` view. Returns ok. */
export async function publishHomeView(token: string, slackUserId: string, view: unknown): Promise<boolean> {
  const result = await slackApi(token, "views.publish", { user_id: slackUserId, view });
  if (!result.ok) {
    console.error("[Slack] publishHomeView error:", result.error);
    return false;
  }
  return true;
}

/** Post an ephemeral message visible only to `user` in `channel` (chat.postEphemeral). */
export async function postEphemeral(
  token: string,
  channel: string,
  user: string,
  blocks: unknown[],
  text: string,
): Promise<boolean> {
  // Slack rejects an empty `blocks` array — send text-only when there are no blocks.
  const body = blocks.length ? { channel, user, blocks, text } : { channel, user, text };
  const result = await slackApi(token, "chat.postEphemeral", body);
  if (!result.ok) {
    console.error("[Slack] postEphemeral error:", result.error);
    return false;
  }
  return true;
}

/** Replace an existing message in place (chat.update) so the channel stays a live to-do list. */
export async function updateMessage(
  token: string,
  channel: string,
  ts: string,
  blocks: unknown[],
  text: string,
): Promise<boolean> {
  const result = await slackApi(token, "chat.update", { channel, ts, blocks, text });
  if (!result.ok) {
    console.error("[Slack] updateMessage error:", result.error);
    return false;
  }
  return true;
}

// ── Inbound: signature verification + workspace resolution ──

/**
 * Verify a Slack request's HMAC signature (X-Slack-Signature / X-Slack-Request-Timestamp).
 * Slack signs `v0:{timestamp}:{rawBody}` with HMAC-SHA256 keyed by SLACK_SIGNING_SECRET.
 * Rejects when the secret is unset, the timestamp skews > 5 min (replay), or the digest mismatches.
 * `rawBody` MUST be the exact unparsed request body.
 */
export function verifySlackSignature(rawBody: string, signature: string | null, timestamp: string | null): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // Replay guard: reject requests older than 5 minutes.
  if (Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Reverse-lookup the ShopCX workspace that owns a Slack `team_id` (saved at OAuth connect). */
export async function resolveWorkspaceByTeamId(teamId: string): Promise<string | null> {
  if (!teamId) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("id")
    .eq("slack_team_id", teamId)
    .maybeSingle();
  return data?.id ?? null;
}

/** Find a channel id by (case-insensitive) name — used to resolve the #roadmap channel for the watcher. */
export async function findChannelByName(token: string, name: string): Promise<string | null> {
  const target = name.replace(/^#/, "").toLowerCase();
  const channels = await listChannels(token);
  return channels.find((c) => c.name.toLowerCase() === target)?.id ?? null;
}

export async function lookupUserByEmail(token: string, email: string): Promise<string | null> {
  // users.lookupByEmail requires GET with query param, not JSON body
  const res = await slackFetch(`${SLACK_API}/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await res.json() as Record<string, unknown>;
  if (!result.ok) return null;
  return (result.user as { id: string })?.id || null;
}

export async function listChannels(token: string): Promise<{ id: string; name: string; is_private: boolean }[]> {
  const byId = new Map<string, { id: string; name: string; is_private: boolean }>();

  // Slack gotcha (verified 2026-06-19): `conversations.list` does NOT return a bot's PRIVATE channels,
  // even with groups:read + the bot invited — it returns ~public only. The reliable source for the
  // channels a bot can actually post to is `users.conversations` (the bot's own memberships, incl
  // private). So merge: conversations.list for all PUBLIC channels (pickable before the bot joins) +
  // users.conversations for everything the bot is a MEMBER of (this is what surfaces #roadmap etc.).
  const collect = async (path: string, types: string) => {
    let cursor: string | undefined;
    // Page cap (SLACK_MAX_PAGES * limit) bounds the loop so a never-emptying
    // cursor can't keep fetching forever; slackFetch bounds each page's wait.
    for (let page = 0; page < SLACK_MAX_PAGES; page++) {
      const params = new URLSearchParams({ types, exclude_archived: "true", limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const res = await slackFetch(`${SLACK_API}/${path}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const result = (await res.json()) as Record<string, unknown>;
      if (!result.ok) break;
      for (const c of (result.channels as { id: string; name: string; is_private: boolean }[]) || []) {
        byId.set(c.id, { id: c.id, name: c.name, is_private: !!c.is_private });
      }
      cursor = (result.response_metadata as { next_cursor?: string })?.next_cursor || undefined;
      if (!cursor) break;
    }
  };

  await collect("conversations.list", "public_channel");
  await collect("users.conversations", "public_channel,private_channel");

  return [...byId.values()];
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
  const res = await slackFetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID || "",
      client_secret: process.env.SLACK_CLIENT_SECRET || "",
      code,
      redirect_uri: `${process.env.NEXT_PUBLIC_SITE_URL}/api/slack/callback`,
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
  const { error } = await admin
    .from("workspaces")
    .update({
      slack_bot_token_encrypted: encrypt(botToken),
      slack_team_id: teamId,
      slack_team_name: teamName,
      slack_connected_at: new Date().toISOString(),
    })
    .eq("id", workspaceId);
  if (error) {
    console.error("[Slack] Failed to save connection:", error);
    throw new Error(`Failed to save Slack connection: ${error.message}`);
  }
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
  rules?: string[];
  reason?: string;
  orderId?: string;
  caseId?: string;
}): { blocks: unknown[]; text: string } {
  const text = `Fraud case detected: ${data.severity} severity for ${data.customer.email}`;
  const detection = data.rules?.length ? data.rules.join(", ") : (data.reason || "AI Fraud Detection");
  const lines = [
    `*Customer:* ${customerLine(data.customer)}`,
    `*Severity:* ${data.severity}`,
    `*Detection:* ${detection}`,
  ];
  if (data.orderId) lines.push(`*Order:* ${data.orderId}`);
  lines.push(`<https://shopcx.ai/dashboard/fraud|Review in ShopCX>`);
  const blocks = [
    headerBlock("🛑", "Fraud Case Detected"),
    sectionBlock(lines.join("\n")),
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

export function buildPartialRefundMessage(data: {
  ticketId?: string;
  customer: { name?: string; email?: string };
  amount: string;
  reason?: string;
  orderNumber?: string;
}): { blocks: unknown[]; text: string } {
  const text = `AI issued partial refund of $${data.amount} to ${data.customer.email}`;
  const blocks = [
    headerBlock("💰", "Partial Refund Issued by AI"),
    sectionBlock(
      `*Customer:* ${customerLine(data.customer)}\n` +
      `*Amount:* $${data.amount}\n` +
      (data.orderNumber ? `*Order:* #${data.orderNumber}\n` : "") +
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
