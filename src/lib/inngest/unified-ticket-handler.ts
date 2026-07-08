/**
 * Unified Ticket Handler v2
 *
 * Single pipeline for ALL inbound messages, all channels.
 *
 * 1. Resolve customer
 * 2. Account linking (always, no confidence needed)
 * 3. Positive close detection
 * 4. Clarification mode (Sonnet on turn 2+)
 * 5. Pattern match first (deterministic)
 * 6. AI classify intent (Haiku backup)
 * 7. Confidence gate (per-channel)
 * 8. Route: journey → workflow → macro → KB → escalate
 * 9. Response delay (per-channel, pre-send stale check)
 * 10. Send (sandbox = draft, live = send)
 * 11. Status (auto_resolve → closed, else → pending)
 */

import { NonRetriableError } from "inngest";
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { OUTAGE_SPANNING_RETRIES, throwForAnthropicStatus, throwForAnthropicNetworkError, isRetryableAnthropicStatus } from "@/lib/anthropic-retry";
import { recordClaudeFailure } from "@/lib/claude-health";
import { assembleTicketContext } from "@/lib/ai-context";
import { retrieveContext } from "@/lib/rag";
import { matchPatterns } from "@/lib/pattern-matcher";
import { sendTicketReply } from "@/lib/email";
import { addTicketTag } from "@/lib/ticket-tags";
import { markFirstTouch } from "@/lib/first-touch";
import { launchJourneyForTicket, nudgeJourney } from "@/lib/journey-delivery";
import { matchPlaybook, matchPlaybookScored, loadDeferThreshold, applyDeferThreshold, startPlaybook, executePlaybookStep, type PlaybookExecResult } from "@/lib/playbook-executor";
import { logAiUsage } from "@/lib/ai-usage";
import { SONNET_MODEL, HAIKU_MODEL } from "@/lib/ai-models";
import { emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";

type Admin = ReturnType<typeof createAdminClient>;

// ── Constants ──

const POSITIVE_PHRASES = [
  "thanks", "thank you", "thank u", "thx", "ty", "got it", "great",
  "perfect", "awesome", "wonderful", "appreciate", "that helps",
  "all good", "all set", "sounds good", "ok great", "ok thanks",
  "ok thank you", "ok cool", "understood", "noted", "good to know",
  "excellent", "much appreciated", "cool thanks", "love it",
];
const MAX_CLARIFY = 3;

// ── Helpers ──

const toHtml = (t: string) => t.split(/\n\n+/).map(p => p.trim()).filter(Boolean).map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");

const sysNote = (admin: Admin, tid: string, msg: string) =>
  admin.from("ticket_messages").insert({ ticket_id: tid, direction: "outbound", visibility: "internal", author_type: "system", body: msg });

function isPositive(body: string): boolean {
  // Strip HTML, normalize whitespace, lowercase
  const stripped = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase().trim();
  // Strip quoted threads / "Sent from" tails first
  const beforeQuote = stripped.split(/(?:sent from|get outlook|on .+ wrote:|from:|----)/)[0].trim();
  // Strip common email-signature openers — "thanks- your friend in real estate, …"
  // and "best, name", "regards, name", "warmly, name". Without this, the word
  // "thanks" inside a signature trips positive-close on substantive replies.
  const beforeSig = beforeQuote.split(/(?:^|[\.\!\?\n\s])(?:thanks[-,\s]+(?:your\s+|warmly|cheers)|warmly,|best,|regards,|sincerely,|kind regards,|cheers,|--\s)/i)[0].trim();
  const c = beforeSig || beforeQuote;

  // Action-intent veto — ALWAYS overrides positive close. A message
  // that asks for something is never closure even when it's wrapped
  // in politeness. Joan Drewry: "Please cancel my subscription. Thank
  // you for your assistance" fired positive-close because "thank you"
  // matched, and Suzie sent "your subscription has been canceled" with
  // no actual cancel. The keyword list mirrors the prior-unanswered
  // sniff later in this file.
  // NOTE on quantity verbs: Mary Ann Madden (ticket 992774c4) replied
  // "August 21 works great. Please reduce the quantity too. Thanks!" —
  // "works great"/"thanks" matched POSITIVE_PHRASES and "reduce"/"quantity"
  // were NOT vetoed, so positive-close fired and the close generator
  // invented "I'll get that updated with the reduced quantity right away"
  // with no change_quantity action ever run. Quantity changes (reduce /
  // fewer / lower / increase / "the quantity") are actionable requests.
  const actionIntent = /\b(cancel|cancell|refund|return|stop|paus|skip|swap|reduce|reducing|reduced|fewer|lower|decrease|increase|quantity|qty|change|update|exchange|replace|replac|missing|damaged|wrong|chargeback|dispute|delivery|tracking|address|reactivate|resume|where is|haven'?t (received|gotten|got))\b/i;
  if (actionIntent.test(c)) return false;

  // Question veto — a message containing a question is never closure
  // even when it ends with "thanks". Customers routinely sign off
  // polite emails like "How do I update my default card? Thanks" —
  // the prior heuristic fired on "thanks" and ignored the question.
  // Dawn Krahn (ticket 744760ef): "how do I make a particular card the
  // default payment? Thanks" closed before we answered. "Thanks in
  // advance" is also pre-emptive politeness, not closure.
  //
  // Detection: ? anywhere OR common interrogative phrasings at the
  // sentence head. We deliberately avoid catching bare "what's up"
  // / standalone "how are you" — those are greetings, not real
  // questions about our service.
  const questionPhrasing = /\b(how\s+(do|can|to|would|should|long|much|many)|what(?:'s|\s+is|\s+are|\s+about|\s+if|\s+happens|\s+will|\s+do\s+i)|when\s+(will|do|can|is|are|does)|where\s+(is|are|can|do|does)|why\s+(is|are|do|does|did)|which\s+(one|card|sub|order|product|works?)|can\s+(you|i|we)|could\s+(you|i)|would\s+(you|i)|will\s+(you|i|it|my)|do\s+(you|i)\s+(have|need|get|use|know|see)|is\s+there\s+(a|any)|are\s+there|is\s+it\s+(possible|ok|okay|alright|safe|too))\b/i;
  // "thanks in advance" → never closure (the customer is pre-thanking
  // for an answer they haven't received yet)
  const thanksInAdvance = /\bthanks?\s+(?:so\s+much\s+)?in\s+advance\b/i;
  if (c.includes("?") || questionPhrasing.test(c) || thanksInAdvance.test(c)) return false;

  // Reject obvious data-only replies — short messages whose meaningful
  // content is nothing more than an order/SKU/tracking ID. Sherri's
  // "And SC127037" tripped positive-close because the signature contained
  // "thanks". A reply that boils down to an ID isn't a closure, it's the
  // customer feeding us more data.
  const orderIdPattern = /\b(SC\d{4,}|[A-Z]{2,}-?\w+-?\d+|#?\d{6,}|trk_\w+)\b/i;
  const wordCount = c.split(/\s+/).filter(Boolean).length;
  const stripped_of_ids = c.replace(orderIdPattern, "").replace(/[\s,.!?]+/g, " ").trim();
  const meaningfulWords = stripped_of_ids.split(/\s+/).filter(w => w.length > 1).length;
  if (wordCount <= 8 && orderIdPattern.test(c) && meaningfulWords <= 2) {
    return false;
  }

  return wordCount <= 50 && POSITIVE_PHRASES.some(p => c.includes(p));
}

function isAccountRelated(intent: string): boolean {
  return ["order", "subscription", "cancel", "billing", "refund", "return", "exchange",
    "address", "payment", "account", "delivery", "shipping", "tracking"]
    .some(k => intent.toLowerCase().includes(k));
}

async function channelCfg(admin: Admin, wsId: string, ch: string) {
  const { data } = await admin.from("ai_channel_config")
    .select("enabled, confidence_threshold, auto_resolve, sandbox, personality_id, instructions, ai_turn_limit, sol_first_touch_enabled")
    .eq("workspace_id", wsId).eq("channel", ch).single();
  return {
    enabled: data?.enabled ?? true,
    threshold: (data?.confidence_threshold ?? 0.7) <= 1 ? Math.round((data?.confidence_threshold ?? 0.7) * 100) : (data?.confidence_threshold ?? 70),
    auto_resolve: data?.auto_resolve ?? false,
    // Sandbox should be opt-in — defaulting to true silently drafts AI
    // replies instead of sending. Discovered when the new help-center
    // contact-form block never sent replies (no help_center config row
    // existed, fallback defaulted to sandbox=true).
    sandbox: data?.sandbox ?? false,
    personality_id: data?.personality_id || null,
    // Sol first-touch opt-in (Phase 3 of sol-ticket-direction-artifact-and-first-touch-box-session).
    // Defaults false — the migration set the column NOT NULL default false, so rollout is opt-in
    // per workspace+channel. When true, an is_new_ticket event acks + enqueues Sol on Max instead
    // of firing the inline Sonnet Step 2e path.
    sol_first_touch_enabled: (data as unknown as { sol_first_touch_enabled?: boolean } | null)?.sol_first_touch_enabled ?? false,
  };
}

async function loadPersonality(admin: Admin, pid: string | null) {
  if (!pid) return null;
  const { data } = await admin.from("ai_personalities")
    .select("name, tone, style_instructions, sign_off, greeting, emoji_usage").eq("id", pid).single();
  return data;
}

async function responseDelay(admin: Admin, wsId: string, ch: string, customerEmail?: string | null): Promise<number> {
  const { data } = await admin.from("workspaces").select("response_delays").eq("id", wsId).single();
  const d = (data?.response_delays || { email: 60, chat: 5, sms: 10, meta_dm: 10, help_center: 5, social_comments: 10, portal: 5 }) as Record<string, unknown>;

  // Skip delay for workspace members (debug/testing)
  if (d.skip_delay_for_members && customerEmail) {
    const { data: members } = await admin.from("workspace_members").select("user_id").eq("workspace_id", wsId);
    for (const m of members || []) {
      const { data: u } = await admin.auth.admin.getUserById(m.user_id);
      if (u?.user?.email?.toLowerCase() === customerEmail.toLowerCase()) return 0;
    }
  }

  return (d[ch] as number) || (d.email as number) || 60;
}

async function newerActivity(admin: Admin, tid: string, since: string): Promise<boolean> {
  const { data } = await admin.from("ticket_messages").select("id")
    .eq("ticket_id", tid).or("author_type.eq.customer,author_type.eq.agent").gt("created_at", since).limit(1);
  return (data?.length || 0) > 0;
}

// ── AI ──

async function claude(prompt: string, model: "haiku" | "sonnet" = "haiku", max = 200, ctx?: { workspaceId?: string; ticketId?: string; purpose?: string; optional?: boolean }): Promise<string> {
  // `optional: true` marks a genuinely-optional enrichment call that may
  // degrade gracefully (return "") on failure — every OTHER caller throws so
  // the Inngest run retries across an outage instead of proceeding on missing
  // data. (agent-outage-resilience Phase 1: no silent error-swallowing.)
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // Missing key is a terminal config error, not a transient outage — fail
    // fast rather than burn hours of retries.
    if (ctx?.optional) return "";
    throw new NonRetriableError("ANTHROPIC_API_KEY is not set");
  }
  const mid = model === "sonnet" ? SONNET_MODEL : HAIKU_MODEL;
  const where = `messages (${ctx?.purpose || "claude-helper"})`;
  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: mid, max_tokens: max, messages: [{ role: "user", content: prompt }] }),
    });
  } catch (e) {
    // Local breaker signal (agent-outage-resilience Phase 2): a network failure is always a retryable
    // dependency failure — feed the consecutive-failure counter before throwing/degrading.
    await recordClaudeFailure(undefined, where);
    if (ctx?.optional) return "";
    throwForAnthropicNetworkError(e, where);
  }
  if (!r.ok) {
    // Was `return ""` — a silent swallow that let callers proceed on empty
    // data (unified-ticket-handler.ts:173). Now throw: retryable status →
    // the run retries with backoff; terminal status → fail fast.
    // A retryable status also feeds the Phase-2 breaker's local signal.
    if (isRetryableAnthropicStatus(r.status)) await recordClaudeFailure(undefined, `${where} → ${r.status}`);
    if (ctx?.optional) return "";
    throwForAnthropicStatus(r.status, where);
  }
  const d = await r.json();
  if (ctx?.workspaceId) {
    void logAiUsage({ workspaceId: ctx.workspaceId, model: mid, usage: d.usage, purpose: ctx.purpose || "claude-helper", ticketId: ctx.ticketId });
  }
  return (d.content?.[0] as { text: string })?.text?.trim() || "";
}

async function classifyIntent(msg: string, ctx: string, hist: string, handlers: string, model: "haiku" | "sonnet" = "haiku", isClarification = false) {
  // Message should already be cleaned by email webhook pipeline
  // but normalize for safety
  const cleanMsg = msg.replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();

  const clarifyBoost = isClarification ? `
IMPORTANT: This is a CLARIFICATION response — the customer was asked to explain their issue and is now telling us. They are clearly stating what they need. Be AGGRESSIVE in matching — if there is ANY mention of charges, refunds, cancellations, subscriptions, orders, or billing issues, match to the most relevant handler with HIGH confidence (80+). Do NOT return "unknown" unless the message truly has no actionable request. Ignore any email signature noise at the end of the message.` : "";

  const raw = await claude(`You are an intent classifier for customer support. Match the customer's message to one of the available handlers below. Only use handler intents listed, or "unknown" if none fit.
${clarifyBoost}
Customer message: "${cleanMsg}"
${ctx ? `Customer:\n${ctx}\n` : ""}
Available handlers:
${handlers || "None"}

Rules:
- "intent" must be an exact trigger intent from the handlers above, or "unknown"
- "confidence" is 0-100
- If vague with no actionable request, return "unknown"
- Charges, refunds, subscriptions, cancellations = match to relevant playbook/journey intent with high confidence

Return JSON only: { "intent": "...", "confidence": 0-100, "reasoning": "one sentence" }`, model);
  try { return JSON.parse(raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "")); }
  catch { return { intent: "unknown", confidence: 0, reasoning: "parse error" }; }
}

async function clarifyQ(msg: string, intent: string, conf: number, ch: string, p: { name?: string; tone?: string } | null) {
  const short = ["chat", "sms", "meta_dm", "portal"].includes(ch);
  const persona = p ? `Your name is ${p.name}. Tone: ${p.tone}.` : "You are a friendly support agent.";
  return (await claude(`${persona} Never reveal AI. Customer: "${msg}". Guess: "${intent}" (${conf}%). Ask ONE clarifying question. ${short ? "Max 20 words." : "Max 30 words."} Only the question.`, "haiku", 80))
    || "Could you tell me a bit more about what you need help with?";
}

async function personalizeMacroText(content: string, ctx: string, msg: string, ch: string, p: { tone?: string } | null) {
  const short = ["chat", "sms", "meta_dm", "portal"].includes(ch);
  const hasLinks = content.includes("<a ");
  // Optional enrichment: the macro `content` is already a complete, valid
  // reply — personalization is a nice-to-have layer on top. So this is the
  // one ticket-path call that degrades gracefully (optional: true) rather than
  // throwing on a Claude failure; the customer still gets the macro.
  return (await claude(`Lightly personalize this response. Insert customer name and relevant details from context. Do NOT make it longer. ${p?.tone ? `Tone: ${p.tone}.` : ""} ${short ? "Very short." : ""}
${hasLinks ? "IMPORTANT: Preserve ALL <a href> HTML links exactly as they appear in the original. Include them in your output." : "No markdown."}
Original: ${content}
Customer question: "${msg}"
${ctx ? `Context: ${ctx.slice(0, 300)}` : ""}
Only the personalized response, nothing else.`, "haiku", 800, { optional: true })) || content;
}

async function kbResponse(article: string, title: string, msg: string, ch: string, p: { tone?: string } | null) {
  const short = ["chat", "sms", "meta_dm", "portal"].includes(ch);
  return (await claude(`Answer using ONLY this KB article. Extract relevant answer. ${short ? "Max 2 sentences." : "Max 3-4 sentences."} No markdown. ${p?.tone ? `Tone: ${p.tone}.` : ""}
Question: "${msg}"
KB "${title}": ${article.slice(0, 1500)}
Only your response.`, "haiku", 500)) || article.slice(0, 500);
}

async function generateJourneyLeadIn(msg: string, journeyName: string, ch: string, p: { name?: string; tone?: string } | null): Promise<{ leadIn: string; ctaText: string }> {
  const short = ["chat", "sms", "meta_dm", "portal"].includes(ch);
  const persona = p ? `Your name is ${p.name}. Tone: ${p.tone}.` : "You are a friendly support agent.";
  const raw = await claude(`${persona} Never reveal AI. Customer sent: "${msg}". You're helping them with "${journeyName}".

Write two things:
1. A brief lead-in message (${short ? "1 sentence" : "2-3 sentences"}) that acknowledges their request and lets them know you're sending a link to help them. Do NOT mention "form", "team", "specialized team", or "department". Keep it simple: "I can help you with that" or "Let me get that taken care of for you." Match their energy.
2. A CTA button label (3-5 words, action-oriented). Use "Manage Subscription" for cancel journeys, not "Cancel Orders Form".

Return JSON: { "lead_in": "...", "cta_text": "..." }`, "haiku", 150);
  try {
    const parsed = JSON.parse(raw.replace(/^```json?\n?/, "").replace(/\n?```$/, ""));
    return { leadIn: parsed.lead_in || `Let me help you with that.`, ctaText: parsed.cta_text || journeyName };
  } catch {
    return { leadIn: `Let me help you with that.`, ctaText: journeyName };
  }
}

async function generatePositiveClose(msg: string, ch: string, p: { name?: string; tone?: string; sign_off?: string | null } | null, autoCloseReply: string | null, ticketId?: string, workspaceId?: string): Promise<string> {
  const short = ["chat", "sms", "meta_dm", "portal"].includes(ch);
  const persona = p ? `Your name is ${p.name}. Tone: ${p.tone}.` : "You are a friendly support agent.";

  // Detect whether this conversation involved a return / refund / cancellation
  // so the close doesn't say "enjoy your order" when they're sending it back.
  let contextHint = "";
  if (ticketId) {
    const admin = createAdminClient();
    const { data: t } = await admin.from("tickets").select("tags").eq("id", ticketId).single();
    const tags = (t?.tags as string[]) || [];
    const isReturnContext = tags.some(tag =>
      tag === "pb:refund" || tag === "pb:return_request" ||
      tag === "j:cancel_subscription" || tag === "j:cancel" ||
      tag === "wb"
    );
    if (isReturnContext) {
      contextHint = ` IMPORTANT: this conversation involved a return / refund / cancellation — do NOT say "enjoy your order", "experience our products", or anything implying the customer is keeping/using the product. A simple "thank you, we appreciate your patience" is right.`;
    }
  }

  // 150 tokens leaves comfortable headroom for "max 2 sentences" + a
  // sign-off without truncation. Earlier 60 was right on the edge —
  // Gail DeRisi's 2026-04-28 close cut at "we look forward to serving"
  // because Haiku ran out of tokens mid-sign-off.
  const raw = await claude(`${persona} Never reveal AI. Customer sent a positive closing message: "${msg}". Write a brief, warm closing reply.${contextHint} ${short ? "Max 1 sentence." : "Max 2 sentences."} ${p?.sign_off ? `End with: ${p.sign_off}` : ""} Only the reply, no markdown.`, "haiku", 150, workspaceId ? { workspaceId, ticketId, purpose: "positive-close" } : undefined);
  return raw || autoCloseReply || (p?.sign_off ? `You're welcome! ${p.sign_off}` : "You're welcome! Let us know if you need anything else.");
}

// ── Send & Status ──

/**
 * Insert an outbound message and send the email.
 *
 * If pending=true, inserts the message as "pending" (visible in UI with countdown)
 * but does NOT send the email yet. The deliverPendingSends cron handles delivery.
 * If pending=false (default), inserts and sends immediately.
 */
async function send(admin: Admin, wsId: string, tid: string, ch: string, msg: string, sandbox: boolean, pending = false, delaySec = 0) {
  const html = toHtml(msg);

  // Tag ticket as AI-handled
  const { addTicketTag } = await import("@/lib/ticket-tags");
  await addTicketTag(tid, "ai");

  if (sandbox) {
    await admin.from("ticket_messages").insert({ ticket_id: tid, direction: "outbound", visibility: "internal", author_type: "ai", body: `[AI Draft] ${html}` });
    return;
  }

  if (pending && delaySec > 0) {
    // Insert as pending — visible in UI immediately, email delivered later by cron
    await admin.from("ticket_messages").insert({
      ticket_id: tid,
      direction: "outbound",
      visibility: "external",
      author_type: "ai",
      body: html,
      pending_send_at: new Date(Date.now() + delaySec * 1000).toISOString(),
    });
    return;
  }

  // Insert and send immediately
  await admin.from("ticket_messages").insert({
    ticket_id: tid,
    direction: "outbound",
    visibility: "external",
    author_type: "ai",
    body: html,
    sent_at: new Date().toISOString(),
  });

  if (ch === "email") {
    const { data: t } = await admin.from("tickets").select("subject, email_message_id, customer_id").eq("id", tid).single();
    if (t?.customer_id) {
      const { data: cust } = await admin.from("customers").select("email").eq("id", t.customer_id).single();
      if (cust?.email) {
        const { data: ws } = await admin.from("workspaces").select("name").eq("id", wsId).single();
        const emailResult = await sendTicketReply({ workspaceId: wsId, toEmail: cust.email, subject: `Re: ${t?.subject || "Your request"}`, body: html, inReplyTo: t?.email_message_id || null, agentName: "Support", workspaceName: ws?.name || "" });
        if (emailResult.messageId) {
          const { logEmailSent } = await import("@/lib/email-tracking");
          await admin.from("ticket_messages").update({ resend_email_id: emailResult.messageId, email_status: "sent", email_message_id: `<${emailResult.messageId}@resend.dev>` }).eq("ticket_id", tid).eq("direction", "outbound").is("resend_email_id", null).order("created_at", { ascending: false }).limit(1);
          await logEmailSent({ workspaceId: wsId, resendEmailId: emailResult.messageId, recipientEmail: cust.email, subject: t?.subject || "Your request", ticketId: tid, customerId: t.customer_id });
        }
      }
    }
  }

  // Portal: always email the customer — most recent message on top, then
  // the conversation history below (external messages only). The portal
  // UI shows the thread too, but the customer isn't necessarily watching
  // it, so email is the guaranteed delivery.
  if (ch === "portal") {
    const { sendPortalThreadEmail } = await import("@/lib/portal/portal-thread-email");
    const msgId = await sendPortalThreadEmail(admin, wsId, tid);
    if (msgId) {
      await admin.from("ticket_messages").update({ resend_email_id: msgId, email_status: "sent" })
        .eq("ticket_id", tid).eq("direction", "outbound").is("resend_email_id", null)
        .order("created_at", { ascending: false }).limit(1);
    }
  }

  // Chat→email fallback: if chat customer has been idle, also send via email
  if (ch === "chat") {
    const { getDeliveryChannel } = await import("@/lib/delivery-channel");
    const effectiveCh = await getDeliveryChannel(tid, ch);
    if (effectiveCh === "email") {
      const { data: t } = await admin.from("tickets").select("customer_id, subject").eq("id", tid).single();
      if (t?.customer_id) {
        const { data: cust } = await admin.from("customers").select("email").eq("id", t.customer_id).single();
        if (cust?.email) {
          const { data: ws } = await admin.from("workspaces").select("name").eq("id", wsId).single();
          const emailResult = await sendTicketReply({
            workspaceId: wsId, toEmail: cust.email,
            subject: `Re: ${t.subject || "Your chat with us"}`,
            body: html,
            inReplyTo: null, agentName: "Support", workspaceName: ws?.name || "",
          });
          // Save email message ID for threading — so replies to this email thread into this ticket
          if (emailResult.messageId) {
            const emailMsgId = `<${emailResult.messageId}@resend.dev>`;
            await admin.from("tickets").update({ email_message_id: emailMsgId }).eq("id", tid);
            await admin.from("ticket_messages").update({ resend_email_id: emailResult.messageId, email_status: "sent" })
              .eq("ticket_id", tid).eq("direction", "outbound").is("resend_email_id", null)
              .order("created_at", { ascending: false }).limit(1);
          }
          await sysNote(admin, tid, `[System] Chat customer idle. Reply also sent via email to ${cust.email}.`);
        }
      }
    }
  }
}

/**
 * sendFirstTouchAck — Phase 3 of sol-ticket-direction-artifact-and-first-touch-box-session.
 *
 * Ship a short per-channel placeholder body ("We got your note — one of the team will get back to
 * you shortly.") through the SAME send() wrapper the orchestrator uses, so the outbound
 * ticket_messages row lands with author_type='ai' + direction='outbound' + the SAME rendering the
 * downstream Sol reply will use. Because Sol's real first reply is authored on a separate turn on
 * Max, this ack is what tells the customer "we saw you" while Sol's session is running.
 *
 * Also inserts a ticket_resolution_events row for this ack turn + stamps shipped_at on it after
 * the send returns, so the spec's Phase-3 verification bullet 1 ("expect a ticket_resolution_events
 * row with shipped_at set (the ack)") holds. Mirrors action-executor.ts § stageResolutionEvent +
 * stampResolutionShipped exactly — CAS on shipped_at IS NULL so a retry can't overwrite the first
 * stamp (learning #1: re-assert the read-time invariant in the write itself). Best-effort — a
 * ledger insert failure NEVER blocks the ack send (mirrors action-executor's swallow-on-ledger
 * pattern; the ledger is diagnostic substrate, not a critical path).
 */
function firstTouchAckBody(channel: string, firstName: string | null): string {
  const hi = firstName ? `Hi ${firstName},` : "Hi there,";
  // Chat-style vs email-style: chat customers see it in a bubble, email customers see it as a body.
  // Same content, slightly different framing so a chat "Thanks for reaching out — one of the team
  // will be right with you." doesn't read like a formal email letter.
  if (channel === "chat" || channel === "meta_dm" || channel === "sms" || channel === "social_comments") {
    return `${hi} thanks for reaching out — one of the team will be right with you.`;
  }
  return `${hi}\n\nThanks for reaching out — we got your note and one of the team will get back to you shortly.`;
}

async function sendFirstTouchAck(admin: Admin, wsId: string, tid: string, ch: string, sandbox: boolean): Promise<void> {
  // Load the customer's first name (best-effort) so the ack reads like the rest of the pipeline
  // instead of a bare "Hi there,". Falls back cleanly when there's no linked customer.
  const { data: t } = await admin
    .from("tickets")
    .select("customer_id")
    .eq("id", tid)
    .single();
  let firstName: string | null = null;
  if (t?.customer_id) {
    const { data: c } = await admin.from("customers").select("first_name").eq("id", t.customer_id).single();
    firstName = (c?.first_name as string | null) ?? null;
  }
  const body = firstTouchAckBody(ch, firstName);

  // Stage a ticket_resolution_events row for THIS turn (the ack). Mirrors action-executor.ts
  // stageResolutionEvent: turn_index = count(prior rows for ticket) + 1 (cheap under the
  // (workspace_id, ticket_id, turn_index) index). Best-effort — never blocks the send.
  let resolutionEventId: string | null = null;
  try {
    const { count } = await admin
      .from("ticket_resolution_events")
      .select("id", { count: "exact", head: true })
      .eq("ticket_id", tid);
    const turnIndex = (count ?? 0) + 1;
    const { data: row } = await admin
      .from("ticket_resolution_events")
      .insert({
        workspace_id: wsId,
        ticket_id: tid,
        turn_index: turnIndex,
        reasoning: "sol_first_touch_ack",
      })
      .select("id")
      .single();
    resolutionEventId = (row as { id: string } | null)?.id ?? null;
  } catch {
    // Ledger is diagnostic substrate — a failed insert must NOT block the ack. Sol's real turn
    // will insert its own ticket_resolution_events row when its send goes through executeSonnetDecision.
  }

  // Actually ship the ack. Uses the SAME send() wrapper the orchestrator uses so per-channel
  // delivery (email/portal/chat idle-fallback) is identical to production.
  await send(admin, wsId, tid, ch, body, sandbox);

  // Compare-and-set shipped_at on the ack's ticket_resolution_events row (per learning #1 —
  // re-assert the read-time precondition on the write itself). Compound key includes
  // workspace_id + is-null so a racing stamp can't overwrite the first-ship timestamp.
  if (resolutionEventId) {
    try {
      await admin
        .from("ticket_resolution_events")
        .update({ shipped_at: new Date().toISOString() })
        .eq("id", resolutionEventId)
        .eq("workspace_id", wsId)
        .is("shipped_at", null);
    } catch {
      // Never fail the ack because the ledger stamp failed.
    }
  }
}

/** Compute delay and call send() as pending if delay > 0, immediate otherwise */
async function sendWithDelay(admin: Admin, wsId: string, tid: string, ch: string, msg: string, sandbox: boolean) {
  // Resolve customer email for skip-delay-for-members check
  const { data: t } = await admin.from("tickets").select("customer_id, detected_language").eq("id", tid).single();
  let custEmail: string | null = null;
  if (t?.customer_id) {
    const { data: c } = await admin.from("customers").select("email").eq("id", t.customer_id).single();
    custEmail = c?.email || null;
  }
  // Translate outbound copy to the customer's detected language when
  // it's not English. Catches every send-path (playbook canned text,
  // macros, holding messages) so a Spanish customer never gets an
  // English template.
  const lang = (t?.detected_language as string | null) || "en";
  let outboundBody = msg;
  if (lang && lang !== "en") {
    const { translateIfNeeded } = await import("@/lib/translate");
    outboundBody = await translateIfNeeded(msg, lang, { workspaceId: wsId, ticketId: tid });
  }
  // If chat customer is idle, use email response delay instead of chat delay
  let effectiveCh = ch;
  if (ch === "chat") {
    const { getDeliveryChannel } = await import("@/lib/delivery-channel");
    const deliveryCh = await getDeliveryChannel(tid, ch);
    if (deliveryCh === "email") effectiveCh = "email";
  }
  // Safety net: convert any bare EasyPost return-label URL the AI pasted as
  // plain text into a clickable CTA button. Catches every send-path so a
  // customer never gets a raw "https://easypost-files.s3..." string in the
  // body (Traci Studebaker, ticket 1b62b00f). Runs after translation so the
  // button markup isn't mangled by the translator.
  const { renderLabelUrlsAsButtons } = await import("@/lib/label-cta");
  outboundBody = renderLabelUrlsAsButtons(outboundBody);

  const delay = await responseDelay(admin, wsId, effectiveCh, custEmail);
  await send(admin, wsId, tid, ch, outboundBody, sandbox, delay > 0, delay);
}

// Policy: any outbound customer message closes the ticket. The
// ticket auto-reopens when the customer replies (inbound webhook
// flips status back to open). The autoResolve param is kept for call
// signature compatibility but no longer differentiates pending vs
// closed — escalations are the only path that should leave a ticket
// open, and those are handled by their own status update at
// escalation time. This avoids tickets sitting in "pending" forever
// when the customer doesn't reply.
const setStatus = (admin: Admin, tid: string, _autoResolve: boolean) =>
  admin.from("tickets").update({ status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString(), escalated_at: null, escalated_to: null, escalation_reason: null }).eq("id", tid);

// Pure decision for the post-execute status block. Kept separate from the
// DB writes so it can be unit-checked (scripts/_regress-workflow-status-authoritative.ts).
// Order matters — the first matching condition wins:
//   • escalated      → leave open; an agent owns it.
//   • status_managed → a workflow already set the authoritative status
//                      (account_login → closed, return_to_sender → open);
//                      leave it untouched. NEVER fall through to setStatus,
//                      which always forces closed and would reopen-then-close
//                      an intentionally-open workflow (Mindy Freeman a89dcf76).
//   • closed         → close_ticket direct action; leave closed.
//   • message_sent   → close the ticket; next inbound reopens.
//   • no_action      → nothing happened; escalate to the To-Do routine if
//                      agent-involved, else keep open for organic review.
export type PostExecuteResult = { messageSent: boolean; escalated: boolean; closed: boolean; statusManaged: boolean };
export type PostExecuteAction = "escalated" | "status_managed" | "closed" | "message_sent" | "no_action_agent" | "keep_open";
export function postExecuteStatusAction(execResult: PostExecuteResult, agentAssigned: boolean): PostExecuteAction {
  if (execResult.escalated) return "escalated";
  if (execResult.statusManaged) return "status_managed";
  if (execResult.closed) return "closed";
  if (execResult.messageSent) return "message_sent";
  return agentAssigned ? "no_action_agent" : "keep_open";
}

// ── Handler names for AI context ──

async function handlerNames(admin: Admin, wsId: string, hasCust: boolean, ch: string) {
  const social = ch === "social_comments";
  const parts: string[] = [];
  if (hasCust && !social) {
    const { data: j } = await admin.from("journey_definitions").select("name, trigger_intent").eq("workspace_id", wsId).eq("is_active", true);
    const internalIntents = new Set(["account_linking"]); // Internal-only, never from customer messages
    for (const x of j || []) {
      if (x.trigger_intent && internalIntents.has(x.trigger_intent)) continue;
      parts.push(`Journey: ${x.name} (intent: ${x.trigger_intent || "n/a"})`);
    }
    const { data: pb } = await admin.from("playbooks").select("name, trigger_intents").eq("workspace_id", wsId).eq("is_active", true);
    for (const x of pb || []) parts.push(`Playbook: ${x.name} (intents: ${(x.trigger_intents as string[]).join(", ") || "n/a"})`);
    const { data: w } = await admin.from("workflows").select("name, trigger_tag").eq("workspace_id", wsId).eq("enabled", true);
    for (const x of w || []) parts.push(`Workflow: ${x.name} (tag: ${x.trigger_tag || "n/a"})`);
  }
  const { data: m } = await admin.from("macros").select("name, category").eq("workspace_id", wsId).limit(50);
  for (const x of m || []) parts.push(`Macro: ${x.name}${x.category ? ` [${x.category}]` : ""}`);
  return parts.join("\n");
}

// ── Escalation ──

async function escalate(admin: Admin, wsId: string, tid: string, ch: string, intent: string, conf: number, msg: string, ctx: string) {
  const suggestion = conf >= 50
    ? `AI suggests: "${intent}" (${conf}%). Check journeys/workflows for this intent.`
    : `Unable to determine customer intent after clarification.`;
  await sysNote(admin, tid, `[System] Escalating. ${suggestion}`);
  const { data: t } = await admin.from("tickets").select("customer_id, subject, email_message_id, detected_language").eq("id", tid).single();

  // Get customer email from profile
  let customerEmail: string | null = null;
  if (t?.customer_id) {
    const { data: cust } = await admin.from("customers").select("email").eq("id", t.customer_id).single();
    customerEmail = cust?.email || null;
  }

  await admin.from("escalation_gaps").insert({
    workspace_id: wsId, ticket_id: tid, customer_id: t?.customer_id || null,
    channel: ch, detected_intent: intent, confidence: conf,
    original_message: msg.slice(0, 2000), customer_context_summary: ctx.slice(0, 1000),
  });

  // Assign to an admin/owner via round-robin (fewest open tickets)
  let assignedTo: string | null = null;
  let assignedName: string | null = null;
  const { data: adminMembers } = await admin.from("workspace_members")
    .select("user_id, display_name")
    .eq("workspace_id", wsId)
    .in("role", ["owner", "admin"])
    .order("user_id");

  if (adminMembers?.length) {
    const counts = await Promise.all(adminMembers.map(async (a) => {
      const { count } = await admin.from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", wsId)
        .eq("assigned_to", a.user_id)
        .eq("status", "open");
      return { ...a, count: count || 0 };
    }));
    counts.sort((a, b) => a.count - b.count);
    assignedTo = counts[0].user_id;
    assignedName = counts[0].display_name;
  }

  await admin.from("dashboard_notifications").insert({
    workspace_id: wsId, type: "escalation_gap",
    title: `AI escalated: ${intent || "unknown"}`, body: `"${msg.slice(0, 100)}..."`,
    metadata: { ticket_id: tid, intent, confidence: conf, assigned_to: assignedName },
  });
  // Agent To-Do system: escalations route to the hourly Claude Code Routine,
  // not to a human. escalated_to/assigned_to stay null; the routine picks up
  // everything where escalated_at IS NOT NULL and no active todo group exists.
  // A human only gets escalated_to set when they reject a todo (see
  // /api/todos/[id]/reject). docs/brain/specs/agent-todo-system.md § Phase 1.
  void assignedTo; void assignedName;
  await admin.from("tickets").update({
    status: "open",
    ai_clarification_turn: 0,
    assigned_to: null,
    escalated_to: null,
    escalated_at: new Date().toISOString(),
    escalation_reason: intent || "unknown",
  }).eq("id", tid);

  await sysNote(admin, tid, `[System] Escalated to the To-Do routine for review.`);

  // Always send a customer-facing message on escalation.
  // Must contain "send you an email" to trigger chatEnded in the widget —
  // we keep that phrase but frame it as a team handoff so it doesn't
  // read as AI-speak ("I ran into an issue / I'll look into it").
  const escalationMsgEn = "Someone on my team is working on this and will send you an email shortly!";

  // Translate to the customer's detected language before send so this
  // matches the rest of the pipeline.
  const lang = (t?.detected_language as string | null) || "en";
  let escalationMsg = escalationMsgEn;
  if (lang && lang !== "en") {
    const { translateIfNeeded } = await import("@/lib/translate");
    escalationMsg = await translateIfNeeded(escalationMsgEn, lang, { workspaceId: wsId, ticketId: tid });
  }

  await sendWithDelay(admin, wsId, tid, ch, escalationMsg, false);

  // Send email for email channel
  if (ch === "email" && customerEmail) {
    const { data: ws } = await admin.from("workspaces").select("name").eq("id", wsId).single();
    await sendTicketReply({
      workspaceId: wsId, toEmail: customerEmail,
      subject: `Re: ${t?.subject || "Your request"}`,
      body: toHtml(escalationMsg),
      inReplyTo: t?.email_message_id || null,
      agentName: "Support", workspaceName: ws?.name || "",
    });
  }
}

// ══════════════════════════════════════════════════
// ── MAIN ──
// ══════════════════════════════════════════════════

export const unifiedTicketHandler = inngest.createFunction(
  // retries: outage-spanning. A Claude/dependency failure now throws (see
  // `claude()` + the Sonnet orchestrator), so the run retries with exponential
  // backoff out to hours — a 1-hour Anthropic outage parks here and completes
  // on recovery instead of failing-and-dropping after 2 attempts. Terminal
  // logic errors throw NonRetriableError, so a real bug still fails fast.
  // (agent-outage-resilience Phase 1.)
  { id: "unified-ticket-handler", retries: OUTAGE_SPANNING_RETRIES, concurrency: [{ limit: 1, key: "event.data.ticket_id" }], triggers: [{ event: "ticket/inbound-message" }] },
  async ({ event, step }) => {
    const { workspace_id: wsId, ticket_id: tid, message_body: msg, channel: ch, is_new_ticket: isNew } = event.data as {
      workspace_id: string; ticket_id: string; message_body: string; channel: string; is_new_ticket: boolean;
    };
    const t0 = new Date().toISOString();
    const admin = createAdminClient();

    // Control Tower: end-of-run heartbeat (try/finally — ok:false on throw). THE crucial loop —
    // if this handler silently stops, customers go unanswered. (control-tower-complete-coverage P1.)
    let __ctOk = true;
    try {

    // ── 0a. System-sentinel short-circuit ──
    // Journey completion paths fire ticket/inbound-message with synthetic
    // body strings ("address_confirmed", "items_selected", "playbook-apply")
    // to wake up an active PLAYBOOK that's waiting for journey output.
    // When no playbook is active, the sentinel has no consumer — running
    // the orchestrator on it just makes Sonnet treat the literal string
    // as a customer message and re-route to the same journey we just
    // completed. Lee Summers' shipping_address ticket showed this:
    // the form was sent twice, the second send was confusing the customer.
    {
      const SENTINEL_MESSAGES = new Set(["address_confirmed", "items_selected", "playbook-apply", "payment_method_added"]);
      const trimmed = (msg || "").trim().toLowerCase();
      if (!isNew && SENTINEL_MESSAGES.has(trimmed)) {
        const { data: ticket } = await admin.from("tickets")
          .select("active_playbook_id").eq("id", tid).maybeSingle();
        if (!ticket?.active_playbook_id) {
          await sysNote(admin, tid, `[System] Sentinel "${trimmed}" — no active playbook; skipping orchestrator.`);
          return { status: "skipped", reason: "sentinel_no_playbook" };
        }
      }
    }

    // ── 0. Empty-inbound short-circuit ──
    // Some email clients send replies whose body is just a quoted thread,
    // a signature, or literally nothing. After stripping HTML/whitespace
    // those land here as empty strings. Treat them as no-op:
    //   • do NOT cancel pending sends already queued from a prior turn
    //   • do NOT re-run the orchestrator / playbook on empty context
    // Without this guard, an empty reply mid-playbook cancels the next
    // beat we already scheduled, and re-running the playbook with empty
    // `msg` makes the AI generate empty responses.
    const stripped = (msg || "").replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
    if (!isNew && stripped.length === 0) {
      await sysNote(admin, tid, "[System] Empty inbound message — skipping pipeline (would have cancelled in-flight send).");
      return { status: "skipped", reason: "empty_inbound" };
    }

    // ── 0b. Bot / contact-form spam short-circuit ──
    // Captcha-bypass bots drop random alphanumeric tokens into both
    // subject AND body of the contact form (e.g. subject
    // "teBoCbeWHnedYfLZBTi" + body "yKORLjDqrriQblpTKc"). Real customers
    // never write a 16-char mixed-case token as their entire email body.
    // Pre-screen with a regex; confirm with Haiku to guard against the
    // edge case (a single-word reply like "Anywhere" that happens to
    // satisfy the alphanumeric pattern).
    //
    // On confirmed spam: tag spam:bot, close, return. No AI reply,
    // no escalation, no agent slot consumed.
    const isBotToken = (s: string) =>
      /^[a-zA-Z0-9]{8,30}$/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
    if (isNew && isBotToken(stripped)) {
      const { data: ticket } = await admin.from("tickets")
        .select("subject").eq("id", tid).maybeSingle();
      const subj = (ticket?.subject || "").trim();
      if (isBotToken(subj)) {
        const verdict = await claude(
          `Subject: ${subj}\nBody: ${stripped}\n\nIs this a bot/spam contact-form submission with no real customer intent? Both fields contain random alphanumeric tokens with no meaning — that's a bot signature. Reply with ONLY one word: YES or NO.`,
          "haiku", 10, { workspaceId: wsId, ticketId: tid, purpose: "spam-check" }
        );
        if (/^YES/i.test(verdict.trim())) {
          await addTicketTag(tid, "spam:bot");
          await admin.from("tickets").update({ status: "closed", escalated_at: null, escalated_to: null, escalation_reason: null }).eq("id", tid);
          await sysNote(admin, tid, `[System] Bot/spam contact-form drop detected — closed silently. (Subject + body both match alphanumeric token pattern; Haiku confirmed.)`);
          return { status: "skipped", reason: "spam_bot" };
        }
        await sysNote(admin, tid, `[System] Subject + body matched bot regex but Haiku said NO ("${verdict.trim().slice(0, 30)}") — proceeding with normal pipeline.`);
      }
    }

    // ── 1. Resolve ──
    const st = await step.run("resolve", async () => {
      const { data: ticket } = await admin.from("tickets")
        .select("customer_id, channel, ai_clarification_turn, agent_intervened, assigned_to, escalated_to, subject, do_not_reply, ai_disabled")
        .eq("id", tid).single();
      if (!ticket) throw new Error("Ticket not found");
      // ── ai_disabled hard gate ──
      // Human directive — a real person clicked "Turn off AI" on this
      // one ticket. Skip EVERY downstream step: orchestrator, playbook,
      // journey, macro, ai-draft. This mirrors the do_not_reply
      // short-circuit below (same sentinel + hard-exit shape) but is
      // an explicit human decision, not a spam/wrong-recipient filter.
      // Non-propagating on merge — see src/lib/ticket-merge.ts.
      if ((ticket as unknown as { ai_disabled?: boolean }).ai_disabled) {
        await sysNote(admin, tid, `[System] Skipped — AI is disabled on this ticket by human directive`);
        return { _aiDisabled: true, hasCust: false, custId: null, custEmail: null, hasShopifyCustomer: false, ch: ticket.channel || ch, turn: 0, intervened: false, assignedTo: null, escalatedTo: null, subject: ticket.subject || "" };
      }
      // ── do_not_reply short-circuit ──
      // Tickets flagged as do_not_reply (wrong_company, wrong_product,
      // spam, etc.) skip all AI processing on inbound messages. The
      // message is logged in ticket_messages by the channel webhook
      // before we get here; we just don't respond.
      if (ticket.do_not_reply) {
        await sysNote(admin, tid, `[System] Skipped — ticket is flagged do_not_reply`);
        // Return a sentinel that downstream steps will short-circuit on.
        return { _doNotReply: true, hasCust: false, custId: null, custEmail: null, hasShopifyCustomer: false, ch: ticket.channel || ch, turn: 0, intervened: false, assignedTo: null, escalatedTo: null, subject: ticket.subject || "" };
      }
      let cust: { id: string; email: string; first_name: string | null; phone: string | null; shopify_customer_id: string | null } | null = null;
      if (ticket.customer_id) {
        const { data } = await admin.from("customers").select("id, email, first_name, phone, shopify_customer_id").eq("id", ticket.customer_id).single();
        cust = data;
      }
      if (cust && isNew) await sysNote(admin, tid, `[System] Customer: ${cust.first_name || ""} (${cust.email})`);
      else if (!cust && isNew) await sysNote(admin, tid, `[System] No customer match`);

      // Check if any linked account has a shopify_customer_id
      let hasShopifyCustomer = !!cust?.shopify_customer_id;
      if (cust && !hasShopifyCustomer) {
        const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", cust.id).maybeSingle();
        if (link) {
          const { data: linked } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id).neq("customer_id", cust.id);
          for (const l of linked || []) {
            const { data: lc } = await admin.from("customers").select("shopify_customer_id").eq("id", l.customer_id).single();
            if (lc?.shopify_customer_id) { hasShopifyCustomer = true; break; }
          }
        }
      }

      return {
        hasCust: !!cust, custId: cust?.id || null, custEmail: cust?.email || null, hasShopifyCustomer,
        ch: ticket.channel || ch, turn: ticket.ai_clarification_turn || 0,
        intervened: !!ticket.agent_intervened,
        assignedTo: ticket.assigned_to || null, escalatedTo: ticket.escalated_to || null,
        subject: ticket.subject || "",
      };
    });

    // Hard exit if AI is disabled on this ticket by human directive.
    // Same shape as the do_not_reply short-circuit — resolve() already
    // logged the audit note; we bail before language detection /
    // classification / orchestrator run.
    if ((st as unknown as { _aiDisabled?: boolean })._aiDisabled) {
      return { skipped: "ai_disabled" };
    }
    // Hard exit if the ticket is flagged do_not_reply. The resolve
    // step already logged the system note; we just stop here and
    // skip everything downstream — language detection, classification,
    // Sonnet, all of it.
    if ((st as unknown as { _doNotReply?: boolean })._doNotReply) {
      return { skipped: "do_not_reply" };
    }

    // ── 1a. Language detection ──
    // Detect the inbound message's language and persist on the ticket
    // so the orchestrator + every send-path can mirror it. Only runs
    // on new tickets (first inbound); replies re-use the stored value.
    const detectedLanguage = await step.run("detect-language", async () => {
      const { data: existing } = await admin.from("tickets")
        .select("detected_language").eq("id", tid).single();
      if (existing?.detected_language) return existing.detected_language as string;
      const { detectLanguage } = await import("@/lib/translate");
      let lang = await detectLanguage(msg, { workspaceId: wsId, ticketId: tid });
      // Anchor on the customer's established language. Single-shot detection
      // occasionally misfires on forwarded English emails (a French sender name
      // + quoted support footer once flipped a long-time English customer to
      // "fr", and we replied in French — Suzanne Doucet). If this customer has
      // ever corresponded in English before, trust that over a fresh non-English
      // guess; a genuine language-switcher would have no English history.
      if (lang !== "en" && st.custId) {
        const { data: prior } = await admin.from("tickets")
          .select("id").eq("workspace_id", wsId).eq("customer_id", st.custId)
          .eq("detected_language", "en").neq("id", tid).limit(1);
        if (prior?.length) lang = "en";
      }
      await admin.from("tickets").update({ detected_language: lang, updated_at: new Date().toISOString() }).eq("id", tid);
      if (lang !== "en") await sysNote(admin, tid, `[System] Detected language: ${lang}. Outbound copy will be translated.`);
      return lang;
    });

    // Agent-involved tickets still get AI processing, but Sonnet limits scope
    // (positive closure OK, new requests get "an agent will be back with you shortly").
    // `let` because the auto-merge below may pull a parent ticket's agent
    // state into this ticket — we re-derive after the merge.
    let agentAssigned = !!(st.assignedTo || st.escalatedTo || st.intervened);

    // ── 1b. Banned customer check ──
    if (st.custId) {
      const banned = await step.run("check-banned", async () => {
        const { data: cust } = await admin.from("customers").select("portal_banned").eq("id", st.custId!).single();
        return !!cust?.portal_banned;
      });
      if (banned) {
        await step.run("handle-banned", async () => {
          const cfg = await channelCfg(admin, wsId, st.ch);
          await sendWithDelay(admin, wsId, tid, st.ch,
            "<p>We're sorry, but we've noticed unusual activity on your account and we are unable to provide further assistance.</p>",
            cfg.sandbox);
          await addTicketTag(tid, "fraud_customer");
          await admin.from("tickets").update({ status: "closed", escalated_at: null, escalated_to: null, escalation_reason: null }).eq("id", tid);
        });
        return { status: "banned_customer" };
      }
    }

    // ── 1a. Auto-merge: combine ALL recent tickets from the same
    // customer (or linked accounts) into this new one. The previous
    // LLM-driven topic-matching was too conservative — two tickets
    // about the same Mixed Berry order with slightly different subjects
    // wouldn't merge. The simpler rule:
    //   Same customer (or linked) + status open|pending|closed + last 14 days
    //   + not system-initiated (crisis email, do_not_reply, test)
    //   → merge them all.
    // We include "closed" because the AI auto-closes after every turn
    // (per the auto-resolve rule), which means almost every prior ticket
    // is closed when a new email arrives — limiting to open/pending
    // skipped almost all merge candidates. mergeTickets() archives the
    // sources and reopens the target if it was closed, so semantics are
    // safe (Yolanda, Joseph, Barbara all had this regression).
    // Risk: customer with multiple unrelated topics gets one mega-thread.
    // Mitigation: trust the orchestrator + agents to handle the drift
    // (they already deal with multi-topic threads from real conversations).
    if (st.custId) {
      const mergeResult = await step.run("auto-merge", async () => {
        const { data: otherTickets } = await admin.from("tickets")
          .select("id, subject, status, created_at, customer_id, tags, merged_into")
          .eq("workspace_id", wsId)
          .eq("customer_id", st.custId!)
          .neq("id", tid)
          .in("status", ["open", "pending", "closed"])
          .is("merged_into", null)
          .order("created_at", { ascending: false })
          .limit(10);

        // Linked accounts
        let linkedTickets: typeof otherTickets = [];
        const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", st.custId!).maybeSingle();
        if (link) {
          const { data: linked } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id).neq("customer_id", st.custId!);
          if (linked?.length) {
            const { data: lt } = await admin.from("tickets")
              .select("id, subject, status, created_at, customer_id, tags, merged_into")
              .eq("workspace_id", wsId)
              .in("customer_id", linked.map(l => l.customer_id))
              .in("status", ["open", "pending", "closed"])
              .is("merged_into", null)
              .order("created_at", { ascending: false })
              .limit(10);
            linkedTickets = lt || [];
          }
        }

        // System-initiated tickets have their own lifecycle — don't
        // suck them into a customer-driven thread.
        const isSystemInitiated = (tags: string[] | null) => {
          if (!tags) return false;
          return tags.some(tag =>
            tag === "crisis" || tag === "do_not_reply" || tag === "test" ||
            tag === "crisis:test" || tag.startsWith("crisis:") || tag === "test:perpetual"
          );
        };

        const ageLimitMs = 14 * 24 * 60 * 60 * 1000;
        const mergeable = [...(otherTickets || []), ...linkedTickets]
          .filter(t => t.id !== tid)
          .filter(t => Date.now() - new Date(t.created_at).getTime() < ageLimitMs)
          .filter(t => !isSystemInitiated(t.tags as string[] | null));

        if (mergeable.length === 0) return null;

        return mergeable.map(t => t.id);
      });

      if (mergeResult && mergeResult.length > 0) {
        // Merge all candidate tickets into this newest one.
        const { mergeTickets } = await import("@/lib/ticket-merge");
        await step.run("merge-tickets", async () => {
          // mergeTickets picks the newest as target — pass them all
          // along with the current ticket id.
          const result = await mergeTickets(wsId, [...mergeResult, tid], "AI Agent");
          if (result.success) {
            const noun = mergeResult.length === 1 ? "ticket" : `${mergeResult.length} tickets`;
            await sysNote(admin, tid, `[System] Auto-merged ${noun} from this customer in the last 14d — ${result.messagesMoved} messages brought forward for context.`);
          }
        });

        // mergeTickets conditionally carries forward assigned_to (only when
        // the source's agent_intervened=true, so a bare routine assignment
        // doesn't flip ownership). agent_intervened itself NO LONGER
        // propagates — Phase 3 of
        // docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md
        // (a merge conveys context, never control). Re-read so the rest of
        // the pipeline sees whatever DID propagate; the inherited-intervened
        // branch is now dead unless the target already carried it — kept for
        // safe forward compatibility with future signals.
        const inherited = await step.run("re-read-agent-state", async () => {
          const { data: t } = await admin.from("tickets")
            .select("agent_intervened, assigned_to, escalated_to")
            .eq("id", tid)
            .single();
          return {
            intervened: !!t?.agent_intervened,
            assignedTo: t?.assigned_to || null,
            escalatedTo: t?.escalated_to || null,
          };
        });
        if (inherited.intervened !== st.intervened || inherited.assignedTo !== st.assignedTo || inherited.escalatedTo !== st.escalatedTo) {
          st.intervened = inherited.intervened;
          st.assignedTo = inherited.assignedTo;
          st.escalatedTo = inherited.escalatedTo;
          agentAssigned = !!(st.assignedTo || st.escalatedTo || st.intervened);
          if (agentAssigned) {
            await sysNote(admin, tid, "[System] Inherited agent assignment from merged-in ticket — Sonnet will defer to agent.");
          }
        }
      }
    }

    const cfg = await step.run("config", () => channelCfg(admin, wsId, st.ch));
    if (!cfg.enabled) return { status: "skipped", reason: "ai_disabled" };
    const pers = await step.run("personality", () => loadPersonality(admin, cfg.personality_id));

    // ── 1b. Three-bucket classification: account / general / outreach ──
    // - account = needs customer data (refund, cancel, order status, etc.)
    // - general = product/policy info questions answerable without account data
    // - outreach = brand collaboration / UGC / partnership / sales pitch /
    //   any inbound from a non-customer with a business proposal we don't
    //   want to engage with as customer service. Bucketing this up front
    //   lets us (a) skip the inline email lookup (no point asking a UGC
    //   creator for the email they used to place an order) and (b) tag
    //   the ticket for analytics filtering.
    let msgType: "account" | "general" | "outreach" = "account";
    if (isNew) {
      msgType = await step.run("classify-bucket", async (): Promise<"account" | "general" | "outreach"> => {
        const cleanMsg = msg.replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
        // System re-triggers always count as account
        if (["address_confirmed", "items_selected", "playbook-apply", "payment_method_added"].includes(cleanMsg)) return "account";

        const check = await claude(
          `Classify this customer message into ONE of three buckets.
- "account" = needs customer account data: refund, cancel, order status, subscription, billing, shipping, missing order, exchange, return, address change, payment issues, login, account access, coupon check, delivery status, complaint about a product they bought
- "general" = product/policy info answerable without account data: ingredients, how to use, pricing, availability, store hours, general company info, do you have X discount
- "outreach" = NOT a customer service request. Brand collaboration, UGC creator pitch, influencer partnership, marketing/PR/business pitch, vendor solicitation, SEO services pitch, link-building outreach, "we'd love to work together" cold email. Signs: portfolio/IG/TikTok links, "collab", "creator", "partnership", "UGC", "we represent", "help your brand grow", "I noticed your website".

Message: "${cleanMsg}"

Respond with EXACTLY one word: "account" or "general" or "outreach".`,
          "haiku", 10, { workspaceId: wsId, ticketId: tid, purpose: "classify-bucket" },
        );
        const lower = (check || "").toLowerCase().trim();
        if (lower.includes("outreach")) return "outreach";
        if (lower.includes("general")) return "general";
        return "account";
      });
      await sysNote(admin, tid, `[System] Classification: ${msgType}`);
    }

    // Tag the bucket so analytics can filter. Outreach gets the bare
    // "outreach" tag too (used by dashboards / queue filtering as a
    // simple "hide noise" toggle).
    if (isNew) {
      await addTicketTag(tid, `cls:${msgType}`);
      if (msgType === "outreach") await addTicketTag(tid, "outreach");
    }

    let pendingAccountLink: { journeyId: string; journeyName: string } | null = null;

    // ── 2. Account path: inline email lookup (stateful conversation) ──
    // Account linking decision moved to Sonnet orchestrator — it decides when linking is needed.
    // Skip the email lookup entirely for general/outreach buckets — asking a
    // UGC creator for the email they used to place an order makes no sense.
    if (st.hasCust && isNew && msgType === "account") {
      // 2b. No Shopify customer → conversational inline flow (keep — stateful)
      if (!st.hasShopifyCustomer) {
        // ── 2b-pre. Order-number short-circuit ──
        // Customer replies to a shipping/order email from a different
        // address than the one on file (Gmail dot-aliasing, work vs.
        // personal, etc.). The order number is right there in the
        // subject/body — extract it, resolve the customer, link the
        // profiles, re-process. Beats asking "what's your email?"
        // when we already know which order they're talking about.
        const subjAndBody = `${st.subject || ""}\n${stripped}`;
        const orderNumbers = Array.from(new Set(
          (subjAndBody.match(/\bSC\d{4,7}\b/gi) || []).map(s => s.toUpperCase())
        ));
        if (orderNumbers.length > 0) {
          const { data: orderMatches } = await admin.from("orders")
            .select("order_number, customer_id, customers!inner(id, email, shopify_customer_id)")
            .eq("workspace_id", wsId)
            .in("order_number", orderNumbers);
          const target = (orderMatches || []).find(o => {
            const c = o.customers as unknown as { id: string; shopify_customer_id: string | null } | null;
            return c?.shopify_customer_id && c.id !== st.custId;
          });
          if (target) {
            const targetCust = target.customers as unknown as { id: string; email: string };
            const { randomUUID } = await import("crypto");
            const { data: existingLink } = await admin.from("customer_links")
              .select("group_id").eq("customer_id", st.custId!).maybeSingle();
            const { data: targetLink } = await admin.from("customer_links")
              .select("group_id").eq("customer_id", targetCust.id).maybeSingle();
            const groupId = existingLink?.group_id || targetLink?.group_id || randomUUID();

            if (!existingLink) {
              await admin.from("customer_links").upsert({
                customer_id: st.custId!, workspace_id: wsId, group_id: groupId, is_primary: false,
              }, { onConflict: "customer_id" });
            }
            if (!targetLink) {
              await admin.from("customer_links").upsert({
                customer_id: targetCust.id, workspace_id: wsId, group_id: groupId, is_primary: true,
              }, { onConflict: "customer_id" });
            }
            await addTicketTag(tid, "link");
            await sysNote(admin, tid, `[System] Resolved customer via order number ${target.order_number}: linked to ${targetCust.email}. Re-processing with full context.`);

            await inngest.send({
              name: "ticket/inbound-message",
              data: { workspace_id: wsId, ticket_id: tid, message_body: msg, channel: st.ch, is_new_ticket: false },
            });
            return { status: "linked_via_order_number", order_number: target.order_number };
          }
        }

        // Check if we're in the inline linking conversation
        const { data: ticketData } = await admin.from("tickets")
          .select("playbook_context").eq("id", tid).single();
        const ctx = (ticketData?.playbook_context || {}) as Record<string, unknown>;

        if (ctx.awaiting_email_confirm) {
          // Customer replied to "is [email] yours?" — check for yes/no
          const lower = msg.toLowerCase().replace(/<[^>]*>/g, " ").trim();
          const isYes = /\b(yes|yeah|yep|correct|that's me|thats me|right|confirm)\b/i.test(lower);

          if (isYes) {
            const altEmail = ctx.alternate_email as string;
            const altCustomerId = ctx.alternate_customer_id as string;

            // Auto-link the accounts
            const { randomUUID } = await import("crypto");
            const { data: existingLink } = await admin.from("customer_links").select("group_id").eq("customer_id", st.custId!).maybeSingle();
            const groupId = existingLink?.group_id || randomUUID();

            if (!existingLink) {
              await admin.from("customer_links").upsert({ customer_id: st.custId!, workspace_id: wsId, group_id: groupId, is_primary: false }, { onConflict: "customer_id" });
            }
            await admin.from("customer_links").upsert({ customer_id: altCustomerId, workspace_id: wsId, group_id: groupId, is_primary: true }, { onConflict: "customer_id" });

            await sysNote(admin, tid, `[System] Accounts linked: ${altEmail} ↔ current customer. Re-processing with full context.`);
            await admin.from("tickets").update({ playbook_context: {} }).eq("id", tid);

            // Re-trigger with the original message
            const origMsg = (ctx.original_message as string) || msg;
            await inngest.send({
              name: "ticket/inbound-message",
              data: { workspace_id: wsId, ticket_id: tid, message_body: origMsg, channel: st.ch, is_new_ticket: false },
            });
            return { status: "inline_linked", email: altEmail };
          } else {
            // They said no or something unclear — ask again or give up
            await admin.from("tickets").update({ playbook_context: {} }).eq("id", tid);
            await sendWithDelay(admin, wsId, tid, st.ch, "No problem! Could you share the email address you used when placing your order? I'll look it up for you.", cfg.sandbox);
            await admin.from("tickets").update({
              playbook_context: { awaiting_alternate_email: true, original_message: ctx.original_message || msg },
            }).eq("id", tid);
            await setStatus(admin, tid, cfg.auto_resolve);
            return { status: "awaiting_alternate_email" };
          }
        }

        if (ctx.awaiting_alternate_email) {
          // Customer provided an alternate email — extract it
          const emailMatch = msg.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
          if (emailMatch) {
            const altEmail = emailMatch[0].toLowerCase();
            const { data: altCust } = await admin.from("customers")
              .select("id, shopify_customer_id, first_name, email")
              .eq("workspace_id", wsId).eq("email", altEmail).single();

            if (altCust?.shopify_customer_id) {
              // Found a Shopify customer — confirm
              const firstName = altCust.first_name || altEmail;
              await sendWithDelay(admin, wsId, tid, st.ch,
                `Just to confirm, ${altEmail} belongs to you? I can see this account has orders in our system.`, cfg.sandbox);
              await admin.from("tickets").update({
                playbook_context: {
                  awaiting_email_confirm: true,
                  alternate_email: altEmail,
                  alternate_customer_id: altCust.id,
                  original_message: ctx.original_message || msg,
                },
              }).eq("id", tid);
              await setStatus(admin, tid, cfg.auto_resolve);
              return { status: "awaiting_email_confirm" };
            } else {
              // Email found but no Shopify customer
              await sendWithDelay(admin, wsId, tid, st.ch,
                "I found that email but don't see any orders associated with it. Could you try the email you used when placing your order?", cfg.sandbox);
              await setStatus(admin, tid, cfg.auto_resolve);
              return { status: "awaiting_alternate_email" };
            }
          } else {
            // No email found in message
            await sendWithDelay(admin, wsId, tid, st.ch,
              "I didn't catch an email address. Could you share the email you used when placing your order?", cfg.sandbox);
            await setStatus(admin, tid, cfg.auto_resolve);
            return { status: "awaiting_alternate_email" };
          }
        }

        // First time hitting no-Shopify-customer — start the conversational flow
        await sysNote(admin, tid, `[System] No Shopify customer found. Starting inline email lookup.`);
        await sendWithDelay(admin, wsId, tid, st.ch,
          "I'd love to help with that! I don't see an order history with the email on file. Did you place your order with a different email address?", cfg.sandbox);
        await admin.from("tickets").update({
          playbook_context: { awaiting_alternate_email: true, original_message: msg },
        }).eq("id", tid);
        await setStatus(admin, tid, cfg.auto_resolve);
        return { status: "no_shopify_customer" };
      }
    }

    // ── 2c. Account linking decision moved to Sonnet orchestrator ──

    // ── 2e + 3. Crisis short-circuit + early pattern match — ALL REMOVED ──
    // Sonnet v2 handles everything including crisis tickets. It sees crisis tags in
    // pre-context and calls get_crisis_status tool when needed. Crisis-specific actions
    // (crisis_pause, crisis_remove, swap_variant) handled by action executor.
    /* DISABLED — Sonnet handles all routing including crisis
    let isCrisisTicket = false;
    if (!isNew && st.hasCust) {
      const crisisTags = await step.run("crisis-tag-check", async () => {
        const { data: t } = await admin.from("tickets").select("tags").eq("id", tid).single();
        return ((t?.tags as string[]) || []).some(tag => tag.startsWith("crisis"));
      });
      isCrisisTicket = crisisTags;
    }
    if (isCrisisTicket && isNew) {
    const earlyPattern = await step.run("early-pattern-match", async () => {
      const m = await matchPatterns(wsId, null, msg);
      if (m && m.confidence >= 0.7) {
        // Only check journeys/playbooks for account messages with a Shopify customer
        if (msgType !== "general" && st.hasShopifyCustomer) {
        // Check if this pattern maps to a journey
        const { data: j } = await admin.from("journey_definitions").select("id, name, trigger_intent, match_patterns")
          .eq("workspace_id", wsId).eq("is_active", true);
        for (const jd of j || []) {
          const intentMatch = jd.trigger_intent && m.category?.toLowerCase().includes(jd.trigger_intent.toLowerCase());
          const patternMatch = (jd.match_patterns as string[] || []).some((p: string) =>
            msg.toLowerCase().includes(p.toLowerCase()));
          if (intentMatch || patternMatch) return { hit: true, type: "journey" as const, id: jd.id, name: jd.name, intent: jd.trigger_intent, patternName: m.name, confidence: m.confidence };
        }
        // Check playbooks
        const { data: pb } = await admin.from("playbooks").select("id, name, trigger_intents, trigger_patterns")
          .eq("workspace_id", wsId).eq("is_active", true);
        for (const p of pb || []) {
          const intents = (p.trigger_intents as string[]) || [];
          const patterns = (p.trigger_patterns as string[]) || [];
          const intentMatch = intents.some(i => m.category?.toLowerCase().includes(i.toLowerCase()));
          const patternMatch = patterns.some(pt => msg.toLowerCase().includes(pt.toLowerCase()));
          if (intentMatch || patternMatch) return { hit: true, type: "playbook" as const, id: p.id, name: p.name, intent: intents[0], patternName: m.name, confidence: m.confidence };
        }
        // Check workflows (e.g. account_login re-trigger on "link expired")
        const autoTag = m.autoTag;
        if (autoTag) {
          const { data: wf } = await admin.from("workflows").select("id, name, trigger_tag")
            .eq("workspace_id", wsId).eq("enabled", true).eq("trigger_tag", autoTag);
          if (wf?.length) return { hit: true, type: "workflow" as const, id: wf[0].id, name: wf[0].name, intent: m.category || "unknown", patternName: m.name, confidence: m.confidence, tag: autoTag };
        }
      }
      } // end if (msgType !== "general" && st.hasShopifyCustomer)

      // Pattern matched at high confidence but no journey/playbook/workflow — pass through for macro lookup
      if (m && m.confidence >= 0.7) {
        return { hit: true, type: "pattern_only" as const, id: "", name: m.name || "", intent: m.category || "unknown", patternName: m.name, confidence: m.confidence };
      }

      // Also check direct journey pattern match (bypass smart patterns) — account path only
      if (msgType !== "general" && st.hasShopifyCustomer) {
      const { data: journeys } = await admin.from("journey_definitions").select("id, name, trigger_intent, match_patterns")
        .eq("workspace_id", wsId).eq("is_active", true);
      const msgLower = msg.toLowerCase().replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/[\u2018\u2019'`]/g, "").replace(/\s+/g, " ").trim();
      for (const jd of journeys || []) {
        const patterns = (jd.match_patterns as string[] || []);
        const matched = patterns.some(p => msgLower.includes(p.toLowerCase().replace(/[''`]/g, "")));
        if (matched) return { hit: true, type: "journey" as const, id: jd.id, name: jd.name, intent: jd.trigger_intent, patternName: "direct pattern", confidence: 1 };
      }
      } // end direct journey check
      return { hit: false } as { hit: false };
    });

    if (earlyPattern.hit) {
      const ep = earlyPattern as { hit: true; type: string; id: string; name: string; intent: string; patternName: string; confidence: number };
      await step.run("early-pattern-note", () =>
        sysNote(admin, tid, `[System] Early pattern match: "${ep.patternName}" → ${ep.type}: ${ep.name} (${(ep.confidence * 100).toFixed(0)}%)`));

      await step.run("clear-clarification", () =>
        admin.from("tickets").update({ ai_clarification_turn: 0 }).eq("id", tid));

      if (ep.type === "journey" && st.hasCust) {
        const delay = await step.run("ep-delay", () => responseDelay(admin, wsId, st.ch, st.custEmail));
        // delay handled by sendWithDelay
        await step.run("ep-journey", async () => {
          if (await newerActivity(admin, tid, t0)) return;
          const { leadIn, ctaText } = await generateJourneyLeadIn(msg, ep.name, st.ch, pers);
          await launchJourneyForTicket({
            workspaceId: wsId, ticketId: tid, customerId: st.custId!,
            journeyId: ep.id, journeyName: ep.name, triggerIntent: ep.intent || "",
            channel: st.ch, leadIn, ctaText,
          });
          await setStatus(admin, tid, cfg.auto_resolve);
        });
        return { status: "early_pattern_journey", journey: ep.name };
      }

      if (ep.type === "playbook" && st.hasCust) {
        await step.run("ep-playbook", async () => {
          const { startPlaybook } = await import("@/lib/playbook-executor");
          await startPlaybook(admin, tid, ep.id);
          await sysNote(admin, tid, `[System] → Playbook: ${ep.name} (${(ep.confidence * 100).toFixed(0)}%)`);
          await markFirstTouch(tid, "ai");
        });
        // Execute first step
        const delay = await step.run("ep-pb-delay", () => responseDelay(admin, wsId, st.ch, st.custEmail));
        // delay handled by sendWithDelay
        const pbResult = await step.run("ep-exec-pb", async () => {
          if (await newerActivity(admin, tid, t0)) return { action: "cancelled" as const };
          return executePlaybookStep(wsId, tid, msg, pers);
        });
        if (pbResult.action !== "cancelled") {
          if (pbResult.systemNote) await step.run("ep-pb-note", () => sysNote(admin, tid, pbResult.systemNote!));
          if (pbResult.response) await step.run("ep-pb-send", () => sendWithDelay(admin, wsId, tid, st.ch, pbResult.response!, cfg.sandbox));
          await step.run("ep-pb-status", () => setStatus(admin, tid, cfg.auto_resolve));
        }
        return { status: "early_pattern_playbook", playbook: ep.name };
      }

      if (ep.type === "workflow" && st.hasCust) {
        const wfTag = (ep as { tag?: string }).tag;
        if (wfTag) {
          const delay = await step.run("ep-wf-delay", () => responseDelay(admin, wsId, st.ch, st.custEmail));
          if (delay > 0) await step.sleep("ep-wf-sleep", `${delay}s`);
          await step.run("ep-exec-workflow", async () => {
            if (await newerActivity(admin, tid, t0)) return;
            const { executeWorkflow } = await import("@/lib/workflow-executor");
            await executeWorkflow(wsId, tid, wfTag);
            await addTicketTag(tid, `w:${ep.name.toLowerCase().replace(/\s+/g, "_")}`);
            await admin.from("tickets").update({ ai_clarification_turn: 0 }).eq("id", tid);
            await setStatus(admin, tid, cfg.auto_resolve);
          });
          return { status: "early_pattern_workflow", workflow: ep.name };
        }
      }

      // Pattern matched but no journey/playbook/workflow — go straight to routeExec for macro lookup
      if (ep.type === "pattern_only") {
        await step.run("pattern-route", async () => {
          const ctx = await assembleTicketContext(wsId, tid);
          const custCtx = ctx.systemPrompt.split("CUSTOMER CONTEXT:")[1]?.split("CHANNEL")[0]?.trim() || "";
          await routeExec(admin, wsId, tid, st.ch, ep.intent, Math.round(ep.confidence * 100), msg, custCtx, st.hasCust, cfg, pers, t0, st.custId || null, pendingAccountLink, st.custEmail);
        });
        return { status: "early_pattern_macro", intent: ep.intent };
      }
    }
    } // end !isCrisisTicket
    END DISABLED CRISIS + PATTERN MATCH */

    // ── 3. Journey/playbook re-nudge REMOVED — Sonnet orchestrator handles all routing
    // Sonnet sees conversation history including pending journeys and decides whether
    // to resend, answer the question, or move on.

    // ── 3b. Active playbook — check if customer message is playbook-related
    // If playbook is active, use Haiku to determine if the message is about the playbook
    // or a completely new topic. Playbook-related → execute step. New topic → Sonnet handles.
    if (!isNew) {
      const pbActive = await step.run("check-playbook", async () => {
        const { data: t } = await admin.from("tickets").select("active_playbook_id").eq("id", tid).single();
        if (!t?.active_playbook_id) return null;

        // Agent intervention supersedes the playbook. Once a human agent
        // has sent an external (customer-facing) reply, they own the
        // conversation — the playbook would otherwise re-fire its
        // clarifying questions on every subsequent customer message
        // (e.g. a customer thank-you 2 days later re-asks the clarification).
        // Internal-only agent activity (notes) doesn't count — those are
        // agent-to-agent comms and shouldn't change the customer flow.
        const { data: agentMsgs } = await admin.from("ticket_messages")
          .select("id")
          .eq("ticket_id", tid)
          .eq("direction", "outbound")
          .eq("visibility", "external")
          .eq("author_type", "agent")
          .limit(1);
        if (agentMsgs && agentMsgs.length > 0) {
          await admin.from("tickets")
            .update({ active_playbook_id: null, playbook_step: 0, playbook_exceptions_used: 0, agent_intervened: true })
            .eq("id", tid);
          await sysNote(admin, tid, `[System] Active playbook cleared — a human agent has replied externally on this ticket, so the playbook is no longer authoritative. Routing to Sonnet.`);
          return null;
        }
        return t.active_playbook_id;
      });

      if (pbActive) {
        // Internal sentinels ("playbook-apply" from an agent applying a playbook,
        // "items_selected"/"address_confirmed" from journey completion) ARE the
        // signal to run the active playbook — never route them through the
        // new-topic classifier. Haiku would see the literal sentinel string,
        // call it NEW_TOPIC, and bounce to the orchestrator, so a freshly-applied
        // playbook would never execute (Ida McDonald 2026-06-10: applied Refund
        // playbook just sat at step 0 and never explained the ineligibility).
        const isSentinel = ["address_confirmed", "items_selected", "playbook-apply", "payment_method_added"].includes(msg.trim().toLowerCase());
        // Ask Haiku: is this message about the active playbook or something new?
        const isPlaybookRelated = isSentinel ? true : await step.run("classify-playbook-msg", async () => {
          const { data: pb } = await admin.from("playbooks").select("name").eq("id", pbActive).single();
          const pbName = pb?.name || "active issue";
          const cleanMsg = msg.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          const result = await claude(
            `A customer has an active "${pbName}" case being handled. They just sent this message:

"${cleanMsg}"

Is this message a continuation of the ${pbName.toLowerCase()} flow, or is the customer asking for something DIFFERENT?

PLAYBOOK = the customer is answering the playbook's prompt, providing requested info (an order #, a yes/no, a specific item they want returned/refunded), confirming, asking a clarifying question about the same issue, or pushing back on an offer in the same flow.

ACCEPT/REJECT OVERRIDES EVERYTHING: If the message accepts or rejects the offer currently on the table ("yes do it", "I'll accept the refund", "no, I want my money back", "that works"), it is PLAYBOOK — even when it is bundled with a tag-on question (e.g. "I'll accept the refund. Are you cancelling the June 15 order?"). The playbook's acceptance handler answers the question AND executes the next step (it generates the return label / issues the resolution). Routing an acceptance to NEW_TOPIC drops it out of the playbook, where there is no return-label guardrail — so the accept signal always wins.

NEW_TOPIC = the customer is switching intent, with NO accept/reject of the active offer. Examples (any of these → NEW_TOPIC, even if the surrounding flow is similar):
  • Requesting a different action: "please pause my subscription" while in a refund flow → NEW_TOPIC
  • Asking about a different subscription / order
  • Adding a new question with no accept/reject ("also, how do I use my points?")
  • Crisis mention ("I got the wrong flavor") while in a generic return flow
  • Pure gratitude, satisfaction, or acknowledgement with no new ask ("thank you!", "right on", "perfect, ty", "👍") → NEW_TOPIC. A happy thank-you is NOT pushback on an offer.

When in doubt, lean NEW_TOPIC — Sonnet has full context to decide if it actually IS the playbook. Calling NEW_TOPIC is cheap (the playbook resumes if Sonnet says so). Calling PLAYBOOK incorrectly buries new asks under stand-firm rounds. The ONE exception to "lean NEW_TOPIC": a clear accept/reject of the active offer is always PLAYBOOK.

Respond with exactly "PLAYBOOK" or "NEW_TOPIC".`, "haiku", 10, { workspaceId: wsId, ticketId: tid, purpose: "playbook-drift-check" });
          return (result || "").trim().toUpperCase().includes("PLAYBOOK");
        });

        if (!isPlaybookRelated) {
          // New topic — let Sonnet handle it normally (falls through to orchestrator)
          await step.run("pb-drift-note", () => sysNote(admin, tid, `[System] Customer message classified as new topic (not related to active playbook). Routing to Sonnet.`));
        } else {
          // Playbook-related — execute the step directly

        const pbResult = await step.run("exec-playbook-step", async () => {
          if (await newerActivity(admin, tid, t0)) return { action: "cancelled" as const };
          return executePlaybookStep(wsId, tid, msg, pers);
        });

        if (pbResult.action === "cancelled") return { status: "cancelled" };

        // Log system note
        if (pbResult.systemNote) await step.run("pb-note", () => sysNote(admin, tid, pbResult.systemNote!));

        // Send response if one was generated
        if (pbResult.response) {
          await step.run("pb-send", () => sendWithDelay(admin, wsId, tid, st.ch, pbResult.response!, cfg.sandbox));
        }

        // Handle API failure escalation
        if (pbResult.action === "escalate_api_failure") {
          await step.run("pb-api-fail", async () => {
            const reason = pbResult.error || pbResult.systemNote || "playbook step could not progress";
            await sysNote(admin, tid, `[System] Playbook API failure: ${reason}. Escalating to the To-Do routine.`);
            // Agent To-Do system: route to the routine, not a human. escalated_to
            // stays null until a human rejects a todo. docs/brain/specs/agent-todo-system.md.
            await admin.from("tickets").update({
              status: "open",
              assigned_to: null, escalated_to: null,
              escalated_at: new Date().toISOString(),
              escalation_reason: reason,
            }).eq("id", tid);
            // Send the customer a holding message so they don't sit in silence
            await sendWithDelay(admin, wsId, tid, st.ch,
              "I need a little time to work on this and I'll get back to you.", cfg.sandbox);
            // Slack notification
            try {
              const { data: ws } = await admin.from("workspaces").select("slack_webhook_url").eq("id", wsId).single();
              if (ws?.slack_webhook_url) {
                const { data: pb } = await admin.from("playbooks").select("name").eq("id", pbActive).single();
                const { data: cust } = await admin.from("customers").select("email, first_name").eq("id", st.custId!).single();
                await fetch(ws.slack_webhook_url, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ text: `🚨 *Playbook Action Failed*\nPlaybook: ${pb?.name || "Unknown"}\nCustomer: ${cust?.first_name || ""} (${cust?.email || ""})\nError: ${reason}\nTicket: https://shopcx.ai/dashboard/tickets/${tid}` }),
                });
              }
            } catch {}
          });
          return { status: "playbook_api_failure", error: pbResult.error };
        }

        // Complete → check queue for next playbook
        if (pbResult.action === "complete") {
          await step.run("pb-complete", async () => {
            const { data: t } = await admin.from("tickets").select("playbook_queue, playbook_context").eq("id", tid).single();
            const queue = (t?.playbook_queue as string[]) || [];
            if (queue.length > 0) {
              const nextId = queue[0];
              const remaining = queue.slice(1);
              await startPlaybook(admin, tid, nextId);
              await admin.from("tickets").update({ playbook_queue: remaining }).eq("id", tid);
              const { data: nextPb } = await admin.from("playbooks").select("name").eq("id", nextId).single();
              await sysNote(admin, tid, `[System] Starting queued playbook: ${nextPb?.name || nextId}`);
            } else {
              // Preserve playbook_context (contains summary for future reference)
              // Clear active playbook but keep context
              await admin.from("tickets").update({
                active_playbook_id: null, playbook_step: 0,
                playbook_exceptions_used: 0,
              }).eq("id", tid);
              // Honor auto-resolve setting
              await setStatus(admin, tid, cfg.auto_resolve);
            }
          });
        } else if (pbResult.action === "respond") {
          // Waiting for customer reply — honor auto-resolve setting
          await step.run("pb-status", () => setStatus(admin, tid, cfg.auto_resolve));
        }

        // Auto-advance: if step resolved without sending a response (e.g. order already
        // identified, subscription lookup, check_other_subs), keep executing next steps
        // until we hit a step that sends a response or completes.
        let advResult: PlaybookExecResult | { action: "cancelled" } = pbResult;
        let advCount = 0;
        const MAX_AUTO_ADVANCE = 10; // safety limit
        while (advResult.action === "advance" && !("response" in advResult && advResult.response) && advCount < MAX_AUTO_ADVANCE) {
          advCount++;
          const r = await step.run(`exec-playbook-advance-${advCount}`, async () => {
            if (await newerActivity(admin, tid, t0)) return { action: "cancelled" as const };
            return executePlaybookStep(wsId, tid, msg, pers);
          });
          advResult = r;
          if (r.action === "cancelled") break;
          const pr = r as PlaybookExecResult;
          if (pr.systemNote) await step.run(`pb-adv-note-${advCount}`, () => sysNote(admin, tid, pr.systemNote!));
          if (pr.response) await step.run(`pb-adv-send-${advCount}`, () => sendWithDelay(admin, wsId, tid, st.ch, pr.response!, cfg.sandbox));
        }

        // Handle the final result after auto-advancing
        if (advCount > 0 && advResult.action !== "cancelled") {
          const finalR = advResult as PlaybookExecResult;
          if (finalR.action === "complete") {
            await step.run("pb-adv-complete", async () => {
              await admin.from("tickets").update({ active_playbook_id: null, playbook_step: 0, playbook_exceptions_used: 0 }).eq("id", tid);
              await setStatus(admin, tid, cfg.auto_resolve);
            });
          } else if (finalR.action === "respond" || finalR.response) {
            await step.run("pb-adv-status", () => setStatus(admin, tid, cfg.auto_resolve));
          }
        }

        return { status: "playbook_step", action: pbResult.action };
        } // end isPlaybookRelated else
      }
    }

    // ── 4. Positive close ──
    // Check on all follow-up messages (not just active handlers) — covers post-playbook "thanks"
    if (!isNew) {
      const isClose = await step.run("check-positive-close", async () => {
        return isPositive(msg);
      });

      if (isClose) {
        // Guard: never auto-close a ticket where a human agent has
        // weighed in. If agent_intervened=true, the AI's job is to
        // hold and acknowledge — not to decide the conversation is
        // over. The agent might still have follow-up work pending.
        // Surfaced on ticket 417cf9eb (Sandy, May 11/12): outreach
        // ticket explicitly marked agent_intervened, customer reacted
        // with a 😊 emoji, positive-close fired and closed the ticket
        // even though 9 sub cancellations still needed to happen.
        const { data: tForGate } = await admin.from("tickets")
          .select("agent_intervened, assigned_to").eq("id", tid).maybeSingle();
        if (tForGate?.agent_intervened || tForGate?.assigned_to) {
          await sysNote(admin, tid, `[System] Positive close suppressed — ticket is agent-handled (agent_intervened=${!!tForGate.agent_intervened}, assigned=${tForGate.assigned_to ? "yes" : "no"}). AI should not close on the customer's behalf.`);
          return { status: "positive_close_suppressed_agent_handled" };
        }

        // Guard: if the CURRENT inbound message arrived within a few
        // minutes of a PRIOR inbound that we haven't responded to yet,
        // the "thanks" is pre-emptive — not real closure. Customers
        // commonly type "Please cancel my subscription" then "Thank you"
        // within seconds, before we've even started processing.
        //
        // Three failure modes to avoid in this check:
        //   1. Don't count the CURRENT message as its own "prior" — look
        //      at the SECOND most-recent inbound.
        //   2. Don't suppress when we've already replied between then
        //      and now — that's a real positive close.
        //   3. Don't suppress on stale prior messages (>5 min). If the
        //      prior is hours old AND we haven't replied, that's an
        //      agent-dropped-ball situation, not a race condition.
        //   4. Use body_clean (strips quoted email reply chain) for the
        //      keyword sniff — our own outbound text often contains
        //      "paused"/"changed" and would false-positive on the raw
        //      body that includes the quoted reply.
        const priorUnanswered = await step.run("check-prior-unanswered", async () => {
          // Two most recent inbounds. [0] is the current one (just
          // inserted by the inbound handler), [1] is the prior.
          const { data: recentInbound } = await admin.from("ticket_messages")
            .select("created_at, body, body_clean")
            .eq("ticket_id", tid)
            .eq("direction", "inbound")
            .order("created_at", { ascending: false })
            .limit(2);
          if (!recentInbound || recentInbound.length < 2) return null;
          const current = recentInbound[0];
          const prior = recentInbound[1];

          // 5-minute window
          const ageSeconds = (Date.now() - new Date(prior.created_at as string).getTime()) / 1000;
          if (ageSeconds > 300) return null;

          // Any outbound external reply between prior and current?
          const { data: replies } = await admin.from("ticket_messages")
            .select("created_at")
            .eq("ticket_id", tid)
            .eq("direction", "outbound")
            .eq("visibility", "external")
            .gt("created_at", prior.created_at as string)
            .lte("created_at", current.created_at as string)
            .limit(1);
          if (replies && replies.length > 0) return null;

          // Keyword sniff on body_clean (no quoted-reply contamination)
          const priorBody = String((prior.body_clean as string) || (prior.body as string) || "")
            .replace(/<[^>]+>/g, " ").toLowerCase();
          if (/cancel|refund|return|stop|wrong|missing|damaged|pause|skip|change|update|swap|charge|dispute/.test(priorBody)) {
            return { lastInboundAt: prior.created_at as string };
          }
          return null;
        });

        if (priorUnanswered) {
          await sysNote(admin, tid, `[System] Positive close suppressed — prior customer message at ${priorUnanswered.lastInboundAt} contains an actionable request and hasn't been responded to. "${msg.slice(0, 80)}" looks pre-emptive. Letting the orchestrator run normally on the prior message.`);
          return { status: "positive_close_suppressed_prior_unanswered" };
        }

        // (Removed: the old "journey form pending → send nudge" guard
        // assumed embedded forms inside the chat/email. We migrated to
        // CTA-link mini-sites, so a pending journey_session just means
        // "we sent a link"; customers who reply "thanks" after that are
        // either acknowledging an action we ALREADY did (the
        // unfulfilled-promise guard below catches the inverse) or have
        // moved on. Cheri Byl, ticket 32a6eed8, got "Whenever you're
        // ready, just fill in the quick form above" after we pushed her
        // renewal — confusing because there's no form above and her
        // ask was already handled. The unfulfilled-promise guard below
        // is the right home for any "thanks while we still owe them
        // something" case.)

        // Guard: if the prior AI message promised an action that was
        // never executed, "thanks" means the customer is trusting we
        // followed through — we shouldn't close until we actually have.
        // Surfaced on Carrie Puckett's ticket (bd095f77): AI said "I'd
        // be glad to set up a free prepaid return label" + customer
        // replied "Yes. Thank you" + positive close fired with no
        // return ever created. Customer came back a day later asking
        // where the label was.
        const unfulfilledPromise = await step.run("check-unfulfilled-promise", async () => {
          const { data: lastOut } = await admin.from("ticket_messages")
            .select("id, body, created_at")
            .eq("ticket_id", tid)
            .eq("direction", "outbound")
            .eq("visibility", "external")
            .in("author_type", ["ai", "agent"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!lastOut) return null;

          // Strip HTML for regex matching.
          const text = (lastOut.body || "").replace(/<[^>]+>/g, " ").replace(/&[^;]+;/g, " ").toLowerCase();

          // Future-tense promise patterns the AI commonly uses for an
          // action that needs to fire. Order verbs by frequency in
          // our own outbound copy.
          const promiseRegex = /\b(i(?:'ll| will| am going to| 'd be (?:glad|happy) to| would be (?:glad|happy) to)|let me)\s+(send|set up|create|generate|prepare|process|get|issue|email|ship|put together)/i;
          if (!promiseRegex.test(text)) return null;

          // Promise detected. Look for any "Action completed" /
          // "Action " system note AFTER this AI message and BEFORE
          // the customer's thanks (now). Also count any action_type
          // direct_action / playbook / journey decisions Sonnet logged.
          const { data: notesAfter } = await admin.from("ticket_messages")
            .select("body")
            .eq("ticket_id", tid)
            .eq("visibility", "internal")
            .eq("author_type", "system")
            .gt("created_at", lastOut.created_at);
          const fulfilled = (notesAfter || []).some((n) => {
            const b = (n.body || "").toLowerCase();
            return b.includes("action completed")
              || b.includes("[playbook]")
              || b.includes("journey")
              || b.includes("return created")
              || b.includes("✓");
          });
          if (fulfilled) return null;
          return { aiMessage: text.slice(0, 200) };
        });

        if (unfulfilledPromise) {
          await sysNote(admin, tid, `[System] Positive close suppressed — prior AI message contained an action promise that wasn't executed. Routing to orchestrator to fulfill instead of closing. Promise context: "${unfulfilledPromise.aiMessage.slice(0, 200)}"`);
          // Fall through the rest of this block so the orchestrator
          // (Section 4 below) runs on this customer message and can
          // actually fire the action that was promised. This is the
          // ONE suppression case that doesn't return early.
        } else {
          const delay = await step.run("close-delay", () => responseDelay(admin, wsId, st.ch, st.custEmail));
          void delay;
          // delay handled by sendWithDelay
          await step.run("send-close", async () => {
            if (await newerActivity(admin, tid, t0)) return;
            const { data: ws } = await admin.from("workspaces").select("auto_close_reply").eq("id", wsId).single();
            const closing = await generatePositiveClose(msg, st.ch, pers, ws?.auto_close_reply || null, tid, wsId);
            await sendWithDelay(admin, wsId, tid, st.ch, closing, cfg.sandbox);
            // Clear any active playbook on a positive close — otherwise a later
            // grateful/follow-up message ("Again, right on!") gets routed back
            // into the stale playbook and fires a tone-deaf stand-firm round
            // (ticket 6e44c252).
            await admin.from("tickets").update({ active_playbook_id: null, playbook_step: 0, playbook_exceptions_used: 0 }).eq("id", tid);
            await setStatus(admin, tid, true);
            await sysNote(admin, tid, `[System] Positive close. Ticket closed. Active playbook cleared.`);
          });
          return { status: "positive_close" };
        }
      }
    }

    // ── 3.5 FRAUD GATE ──
    // Pre-flight check before the orchestrator runs. Bails on ANY of:
    //   - confirmed fraud_case (any rule_type)
    //   - amazon_reseller fraud_case (any status — even unconfirmed)
    //   - any of the customer's order ship/bill addresses matches an
    //     active known_resellers row
    // On hit: send the canonical refusal, escalate to a human agent
    // (so an admin can review), skip the orchestrator entirely.
    if (st.custId) {
      const { getCustomerFraudStatus, shouldBlockOrchestrator, describeBlockReason, pickBlockReply }
        = await import("@/lib/customer-fraud-status");
      const fraudGate = await step.run("fraud-gate", async () => {
        return await getCustomerFraudStatus(admin, wsId, st.custId);
      });
      if (shouldBlockOrchestrator(fraudGate)) {
        const reason = describeBlockReason(fraudGate);
        const reply = pickBlockReply(fraudGate);

        // Chargeback path is "send one reply, then silence." If we've
        // already sent the canonical chargeback notice (reply === null),
        // close the ticket silently — no agent escalation, no further
        // engagement. Otherwise send the notice once, mark
        // chargeback_notice_sent_at, and close.
        if (fraudGate.hasChargeback) {
          await step.run("chargeback-gate-block", async () => {
            if (await newerActivity(admin, tid, t0)) return;
            if (reply) {
              await sendWithDelay(admin, wsId, tid, st.ch, reply, cfg.sandbox);
              // Mark notice as sent on the customer + every linked profile
              // so future tickets from any of them are silent-close.
              const { data: linkRow } = await admin.from("customer_links")
                .select("group_id").eq("customer_id", st.custId).maybeSingle();
              const ids: string[] = [st.custId!];
              if (linkRow) {
                const { data: grp } = await admin.from("customer_links")
                  .select("customer_id").eq("group_id", linkRow.group_id);
                for (const g of grp || []) if (!ids.includes(g.customer_id)) ids.push(g.customer_id);
              }
              await admin.from("customers")
                .update({ chargeback_notice_sent_at: new Date().toISOString() })
                .in("id", ids);
              await sysNote(admin, tid, `[System] CHARGEBACK GATE: ${reason}. Sent canonical notice. Closing silently.`);
            } else {
              await sysNote(admin, tid, `[System] CHARGEBACK GATE: ${reason}. Notice already sent — closing silently with no reply.`);
            }
            await setStatus(admin, tid, true);  // close
          });
          return { status: "chargeback_blocked", reason };
        }

        // Fraud / banned path — send the canonical refusal once, then
        // deactivate the ticket (do_not_reply + close). No escalation:
        // a reseller doesn't get an agent's time, and the do_not_reply
        // flag short-circuits future inbound on this thread (plus the
        // auto-analyzer skips do_not_reply tickets). If the customer
        // opens a fresh ticket later, auto-merge propagates do_not_reply
        // forward and they get silenced again with no second refusal.
        await step.run("fraud-gate-block", async () => {
          if (await newerActivity(admin, tid, t0)) return;
          if (reply) await sendWithDelay(admin, wsId, tid, st.ch, reply, cfg.sandbox);
          await sysNote(admin, tid, `[System] FRAUD GATE: ${reason}. Sent canonical refusal. Deactivating ticket.`);
          await admin.from("tickets").update({
            status: "closed",
            do_not_reply: true,
            do_not_reply_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", tid);
        });
        return { status: "fraud_blocked", reason };
      }
    }

    // ── 3.8 AUTO-LINK FROM INLINE EMAILS ──
    // Customers often answer the linking question in their FIRST
    // message ("my husband's email is X"). Linking those accounts
    // proactively — before Sonnet runs — lets the orchestrator see
    // the merged customer data via get_customer_account and route
    // straight to the right journey (cancel, refund, etc.) instead
    // of asking the linking question they already answered.
    if (st.custId && msg) {
      await step.run("auto-link-from-inbound", async () => {
        const { autoLinkCustomerFromMessage } = await import("@/lib/auto-link-customer-from-message");
        const result = await autoLinkCustomerFromMessage(admin, wsId, tid, st.custId!);
        if (result.linkedCount > 0) {
          await sysNote(
            admin,
            tid,
            `[System] Auto-linked ${result.linkedCount} account${result.linkedCount === 1 ? "" : "s"} from inline email/order-number mention(s) in inbound messages: ${result.linkedEmails.join(", ")}`,
          );
        }
      });
    }

    // ── 3.9 AUTO-LINK BY IDENTITY (exact name + address) ──
    // Same person, split across two profiles (e.g. a hotmail and an
    // outlook address) where the active subscription / renewal order
    // lives on the profile the ticket ISN'T linked to. The customer
    // can't quote an order number or alternate email (they don't know
    // it), so the inline scan above finds nothing. An exact-after-
    // normalization name+address match is a high-confidence "same
    // human" signal — link it without asking, so get_customer_account
    // returns the merged set and refund/cancel playbooks can fire.
    if (st.custId) {
      await step.run("auto-link-by-identity", async () => {
        const { autoLinkCustomerByIdentity } = await import("@/lib/auto-link-customer-from-message");
        const result = await autoLinkCustomerByIdentity(admin, wsId, st.custId!);
        if (result.linkedCount > 0) {
          await sysNote(
            admin,
            tid,
            `[System] Auto-linked ${result.linkedCount} account${result.linkedCount === 1 ? "" : "s"} by exact name + address match: ${result.linkedEmails.join(", ")}`,
          );
        }
      });
    }

    // ── 3.95 SOL FIRST-TOUCH DISPATCH ──
    // Phase 3 of sol-ticket-direction-artifact-and-first-touch-box-session. When the workspace has
    // opted the channel into Sol's first-touch box session AND this is a fresh ticket (is_new_ticket)
    // AND no agent is already involved AND fraud didn't block above, we invert the cost curve:
    // ship a short ack RIGHT NOW (so the customer sees a response within seconds), enqueue a
    // top-level Max session for Sol to author the durable Direction + the real first customer-facing
    // reply, then RETURN — the inline Sonnet Step 2e path below is skipped for this turn.
    //
    // Guards, in order (learning #2 — compare-and-set + narrow the enumeration source before
    // mutating): (1) is_new_ticket must be true — a reply on an existing ticket falls through to
    // the orchestrator; (2) cfg.sol_first_touch_enabled must be true — default false + opt-in per
    // ai_channel_config row means an unconfigured channel takes the original path (verification
    // bullet 3); (3) !agentAssigned — a human is already handling this ticket, don't step on their
    // toes (agent_intervened / assigned_to / escalated_to all set agentAssigned above). Fraud is
    // already handled — a fraud-blocked ticket returned above at line ~1730 (verification bullet 4).
    if (isNew && cfg.sol_first_touch_enabled && !agentAssigned) {
      const acked = await step.run("sol-first-touch-ack", async () => {
        if (await newerActivity(admin, tid, t0)) return false;
        await sendFirstTouchAck(admin, wsId, tid, st.ch, cfg.sandbox);
        await sysNote(admin, tid, `[System] Sol first-touch: ack sent — dispatching kind='ticket-handle' agent_jobs.`);
        return true;
      });

      if (acked) {
        // Enqueue Sol's box session. Learning #1: the enqueue is scoped to this workspace + this
        // ticket + this turn's reason, and Sol's runTicketHandleJob re-guards on the required
        // Direction fields before it calls writeDirection — so a mis-formed session never lands a
        // partial-UNIQUE-violating row on ticket_directions. `turn_index` is not the ticket-messages
        // turn — it's the resolution-events turn index (2 = the ack was turn 1, Sol's real reply
        // will be turn 2), included for downstream observability.
        await step.run("sol-first-touch-enqueue", async () => {
          const turnIndex = 2; // ack = 1; Sol authors turn 2 via executeSonnetDecision → stageResolutionEvent
          // No ticket_id column on agent_jobs — the shape is workspace_id + spec_slug + kind +
          // instructions (JSON with the per-kind payload). runTicketHandleJob parses ticket_id +
          // workspace_id from the instructions blob (mirrors ticket-improve's params-in-JSON pattern).
          await admin.from("agent_jobs").insert({
            workspace_id: wsId,
            kind: "ticket-handle",
            spec_slug: `ticket-handle-${tid.slice(0, 8)}`,
            status: "queued",
            instructions: JSON.stringify({
              ticket_id: tid,
              workspace_id: wsId,
              turn_index: turnIndex,
              reason: "first_touch",
            }),
          });
        });
        return { status: "sol_first_touch_dispatched", channel: st.ch };
      }
    }

    // ── 3.98 SOL PLAYBOOK SHORT-CIRCUIT ──
    // Phase 4 of docs/brain/specs/sol-cheap-execution-over-ticket-direction.md. When Sol
    // committed the ticket to a playbook at first-touch (live Direction chosen_path='playbook')
    // AND the playbook is still running (tickets.active_playbook_id NOT NULL), we drive this
    // follow-up turn directly through executePlaybookStep and SKIP the Sonnet orchestrator —
    // a zero-cost, deterministic turn instead of paying for another Sonnet/Opus decision.
    //
    // Guards (learning #2 — narrow before mutating):
    //  (1) loadLiveDirection returns non-null AND superseded_at is null — the Direction is
    //      still authoritative for this ticket. maybeSingle() under the DB partial-UNIQUE
    //      makes multi-live-row states impossible; a mis-authored Direction just returns null.
    //  (2) chosen_path === "playbook" — a stateless/needs_info Direction falls through to the
    //      Sonnet path so those turns can still take the Phase-3 Haiku route.
    //  (3) tickets.active_playbook_id IS NOT NULL AND the ticket row is scoped by workspace —
    //      the playbook was completed or its exception limit was exhausted → NO short-circuit,
    //      fall through to the orchestrator (spec bullet 2: the assembleDirectionContext path
    //      Phase 2 wires; until Phase 2 ships, the fall-through is the existing Sonnet path).
    //
    // Ledger: stage a ticket_resolution_events row with reasoning='sol:playbook-shortcircuit',
    // then CAS shipped_at (learning #1) — same stage → send → stamp pattern as sendFirstTouchAck.
    // Ledger writes are best-effort — a diagnostic-substrate failure MUST NOT block the send.
    const solPlaybookShortCircuit = await step.run("sol-playbook-shortcircuit-check", async () => {
      const { loadLiveDirection } = await import("@/lib/ticket-directions");
      const direction = await loadLiveDirection(admin, tid, { workspace_id: wsId });
      if (!direction || direction.superseded_at) return null;
      if (direction.chosen_path !== "playbook") return null;
      const { data: ticketRow } = await admin
        .from("tickets")
        .select("active_playbook_id")
        .eq("workspace_id", wsId)
        .eq("id", tid)
        .maybeSingle();
      const activePlaybookId = (ticketRow?.active_playbook_id as string | null) ?? null;
      if (!activePlaybookId) return null;
      return { direction_id: direction.id, active_playbook_id: activePlaybookId };
    });

    if (solPlaybookShortCircuit) {
      const shortCircuitOutcome = await step.run("sol-playbook-shortcircuit-execute", async () => {
        if (await newerActivity(admin, tid, t0)) return { skipped: true as const };

        // Stage a ticket_resolution_events row for THIS zero-Sonnet turn. turn_index =
        // count(prior rows) + 1 (cheap under the (workspace_id, ticket_id, turn_index)
        // index), same rule Sol's ack + the orchestrator use. reasoning is the exact
        // spec-verification string 'sol:playbook-shortcircuit' so cost analytics can
        // count zero-cost short-circuited turns without a heuristic classifier.
        let resolutionEventId: string | null = null;
        try {
          const { count } = await admin
            .from("ticket_resolution_events")
            .select("id", { count: "exact", head: true })
            .eq("ticket_id", tid);
          const turnIndex = (count ?? 0) + 1;
          const { data: row } = await admin
            .from("ticket_resolution_events")
            .insert({
              workspace_id: wsId,
              ticket_id: tid,
              turn_index: turnIndex,
              reasoning: "sol:playbook-shortcircuit",
            })
            .select("id")
            .single();
          resolutionEventId = (row as { id: string } | null)?.id ?? null;
        } catch {
          // Ledger is diagnostic — a failed insert must NOT block the customer-facing send.
        }

        // Run the playbook step. Same call the pipeline's `2. Playbook` block uses (line
        // ~2340); the short-circuit is just an earlier entry — one effector, two entry paths.
        const result = await executePlaybookStep(wsId, tid, msg, pers);
        if (result.systemNote) await sysNote(admin, tid, result.systemNote);
        if (result.response) await sendWithDelay(admin, wsId, tid, st.ch, result.response, cfg.sandbox);

        // Compare-and-set shipped_at (learning #1 — re-assert the read-time invariant on
        // the write itself). Compound key includes workspace_id + is-null so a racing
        // stamp cannot overwrite the first-ship timestamp.
        if (resolutionEventId) {
          try {
            await admin
              .from("ticket_resolution_events")
              .update({ shipped_at: new Date().toISOString() })
              .eq("id", resolutionEventId)
              .eq("workspace_id", wsId)
              .is("shipped_at", null);
          } catch {
            // Never fail the short-circuit turn because the ledger stamp failed.
          }
        }

        await setStatus(admin, tid, cfg.auto_resolve);
        return { skipped: false as const, action: result.action, hasResponse: !!result.response };
      });

      if (!shortCircuitOutcome.skipped) {
        return { status: "sol_playbook_shortcircuit", action: shortCircuitOutcome.action };
      }
    }

    // ── 4. SONNET ORCHESTRATOR ──
    // Sonnet analyzes the full request and decides the best action. Replaces pattern matching,
    // AI classification, confidence gate, and routeExec cascading lookup.
    {
      const { callSonnetOrchestratorV2 } = await import("@/lib/sonnet-orchestrator-v2");
      const { executeSonnetDecision } = await import("@/lib/action-executor");
      const { pickOrchestratorModel } = await import("@/lib/model-picker");
      const { applyNoProgressCircuit } = await import("@/lib/no-progress-guard");

      // ── No-progress circuit (Phase 3 of ticket-merge-summary-and-context-cap) ──
      // Before paying for another Sonnet/Opus turn, check whether the
      // ticket is stuck in a loop: M consecutive inbound customer
      // messages with no outbound reply or action executed. If so,
      // surface it for human review instead of firing the orchestrator.
      // Kept above the model-picker + orchestrator call so a stuck loop
      // never reaches the paid Opus escalation (`ai_turn_count >= 1 →
      // Opus` per model-picker.ts).
      const noProgress = await step.run("no-progress-guard", async () =>
        applyNoProgressCircuit(admin, wsId, tid),
      );
      if (noProgress.tripped) {
        return { status: "no_progress_circuit_tripped", streak: noProgress.streak };
      }

      const sonnetDecision = await step.run("sonnet-orchestrate", async () => {
        // Phase 3 of docs/brain/specs/sol-cheap-execution-over-ticket-direction.md —
        // load the live Direction (if any) BEFORE the picker so the fresh-Direction
        // Haiku route can fire. loadLiveDirection returns null when Sol hasn't
        // authored one yet (legacy tickets / workspaces without sol_first_touch_enabled);
        // the picker treats that as "no candidate for the Haiku route" and falls
        // through to the existing Sonnet-vs-Opus rules.
        const { loadLiveDirection } = await import("@/lib/ticket-directions");
        const liveDirection = await loadLiveDirection(admin, tid, { workspace_id: wsId });
        const pick = await pickOrchestratorModel({ workspaceId: wsId, ticketId: tid, customerId: st.custId || null, direction: liveDirection });
        await sysNote(admin, tid, `[System] Orchestrator model: ${pick.model} (${pick.reason})`);
        const decision = await callSonnetOrchestratorV2(wsId, tid, st.custId || "", msg, st.ch, pers,
          agentAssigned ? { assigned: true, intervened: st.intervened } : null,
          pick);
        await sysNote(admin, tid, `[System] ${pick.model === "opus" ? "Opus" : "Sonnet"}: ${decision.action_type} — ${decision.reasoning}`);
        return decision;
      });

      // Actions execute immediately — message delay handled by sendWithDelay (pending_send_at)
      await step.run("sonnet-execute", async () => {
        if (await newerActivity(admin, tid, t0)) return;
        const { data: wsForSandbox } = await admin.from("workspaces").select("sandbox_mode").eq("id", wsId).single();
        const isSandbox = wsForSandbox?.sandbox_mode === true || cfg.sandbox === true;
        const execResult = await executeSonnetDecision(
          { admin, workspaceId: wsId, ticketId: tid, customerId: st.custId || "", channel: st.ch, sandbox: isSandbox, agentInvolved: agentAssigned },
          sonnetDecision,
          pers,
          async (m, sb) => sendWithDelay(admin, wsId, tid, st.ch, m, sb),
          async (m) => { await sysNote(admin, tid, m); },
        );
        // Post-execute status — decision in postExecuteStatusAction (above).
        switch (postExecuteStatusAction(execResult, agentAssigned)) {
          case "escalated":
            await sysNote(admin, tid, "[System] Ticket escalated this run — leaving open for agent.");
            break;
          case "status_managed":
            // A workflow already set the authoritative final status
            // (account_login → closed, return_to_sender → open). Leave it
            // untouched — routing through setStatus would force closed and
            // reopen-then-close an intentionally-open workflow (Mindy
            // Freeman a89dcf76: the magic-link close was being reopened).
            await sysNote(admin, tid, "[System] Workflow set the ticket status directly — leaving it as-is.");
            break;
          case "closed":
            await sysNote(admin, tid, "[System] Ticket closed via close_ticket action — no customer reply expected.");
            break;
          case "message_sent":
            await setStatus(admin, tid, cfg.auto_resolve);
            break;
          case "no_action_agent":
            // Orchestrator took no customer-facing action on an agent-involved
            // ticket — the assigned agent needs a signal a customer message is
            // waiting (Suzanne Doucet 2026-06-02: replied "thanks", nothing
            // happened, ticket sat open). Route to the To-Do routine, not a
            // human. escalated_to stays null until a human rejects a todo.
            // docs/brain/specs/agent-todo-system.md.
            await admin.from("tickets").update({
              status: "open",
              assigned_to: null,
              escalated_to: null,
              escalated_at: new Date().toISOString(),
              escalation_reason: "no_action_on_agent_ticket",
            }).eq("id", tid);
            await sysNote(admin, tid, "[System] Customer replied on agent-involved ticket; orchestrator took no action — escalated to the To-Do routine for review.");
            break;
          case "keep_open":
            await admin.from("tickets").update({ status: "open" }).eq("id", tid);
            await sysNote(admin, tid, "[System] No customer message sent — ticket kept open for agent review.");
            break;
        }
      });

      return { status: `sonnet_${sonnetDecision.action_type}`, reasoning: sonnetDecision.reasoning };
    }

    /* ── OLD PIPELINE (disabled — replaced by Sonnet orchestrator above) ──
    // ── 4. Clarification mode ──
    if (st.turn > 0 && st.turn < MAX_CLARIFY) {
      return await step.run("clarify", async () => {
        // First try pattern matching on the clarification message (deterministic, fast)
        // Normalize: strip HTML entities, apostrophes, smart quotes for fuzzy matching
        const normalize = (s: string) => s.toLowerCase()
          .replace(/<[^>]*>/g, " ")     // HTML tags
          .replace(/&[^;]+;/g, "")      // HTML entities
          .replace(/[\u2018\u2019\u0027\u2032]/g, "")  // smart quotes + apostrophes
          .replace(/[''`]/g, "")        // other quote chars
          .replace(/\s+/g, " ")         // normalize whitespace
          .trim();
        const msgNorm = normalize(msg);

        const { data: playbooks } = await admin.from("playbooks")
          .select("id, name, trigger_intents, trigger_patterns")
          .eq("workspace_id", wsId).eq("is_active", true);
        for (const pb of playbooks || []) {
          const patterns = (pb.trigger_patterns as string[]) || [];
          const matched = patterns.some(p => msgNorm.includes(normalize(p)));
          if (matched) {
            const intent = (pb.trigger_intents as string[])?.[0] || "unknown";
            await sysNote(admin, tid, `[System] Clarify pattern match: "${intent}" via playbook "${pb.name}"`);
            await admin.from("tickets").update({ ai_detected_intent: intent, ai_intent_confidence: 95, ai_clarification_turn: 0 }).eq("id", tid);
            await routeExec(admin, wsId, tid, st.ch, intent, 95, msg, "", st.hasCust, cfg, pers, t0, st.custId, null, st.custEmail);
            return { status: "routed_after_clarify_pattern", intent };
          }
        }

        const model = st.turn >= 1 ? "sonnet" as const : "haiku" as const;
        const ctx = await assembleTicketContext(wsId, tid);
        const custCtx = ctx.systemPrompt.split("CUSTOMER CONTEXT:")[1]?.split("CHANNEL")[0]?.trim() || "";
        const hist = ctx.conversationHistory.map(m => `${m.role}: ${m.content}`).join("\n");
        const hNames = await handlerNames(admin, wsId, st.hasCust, st.ch);
        const intent = await classifyIntent(msg, custCtx, hist, hNames, model, true);
        await sysNote(admin, tid, `[System] Clarify turn ${st.turn + 1}: "${intent.intent}" (${intent.confidence}%) [${model}]`);
        await admin.from("tickets").update({ ai_detected_intent: intent.intent, ai_intent_confidence: intent.confidence }).eq("id", tid);

        if (intent.confidence >= cfg.threshold) {
          await admin.from("tickets").update({ ai_clarification_turn: 0 }).eq("id", tid);
          await routeExec(admin, wsId, tid, st.ch, intent.intent, intent.confidence, msg, custCtx, st.hasCust, cfg, pers, t0, st.custId, null, st.custEmail);
          return { status: "routed_after_clarify", intent: intent.intent };
        }
        const next = st.turn + 1;
        await admin.from("tickets").update({ ai_clarification_turn: next }).eq("id", tid);
        if (next >= MAX_CLARIFY) {
          await escalate(admin, wsId, tid, st.ch, intent.intent, intent.confidence, msg, custCtx);
          return { status: "escalated", reason: "max_clarify" };
        }
        const q = await clarifyQ(msg, intent.intent, intent.confidence, st.ch, pers);
        const delay = await responseDelay(admin, wsId, st.ch, st.custEmail);
        if (delay > 0) await new Promise(r => setTimeout(r, delay * 1000));
        if (await newerActivity(admin, tid, t0)) return { status: "bailed", reason: "newer_msg" };
        await sendWithDelay(admin, wsId, tid, st.ch, q, cfg.sandbox);
        await setStatus(admin, tid, cfg.auto_resolve);
        return { status: "clarify_sent", turn: next };
      });
    }

    // ── 5. Pattern match first ──
    const pmatch = await step.run("pattern-match", async () => {
      const m = await matchPatterns(wsId, st.subject, msg);
      if (m && m.confidence >= 0.7) {
        await sysNote(admin, tid, `[System] Pattern: "${m.name}" (${m.category}) ${(m.confidence * 100).toFixed(0)}% via ${m.method}`);
        return { hit: true, tag: m.autoTag, cat: m.category, name: m.name };
      }
      return { hit: false, tag: null, cat: null, name: null };
    });

    // Also check journey match_patterns directly (no smart pattern needed)
    const journeyDirect = !pmatch.hit && st.hasCust && st.ch !== "social_comments"
      ? await step.run("journey-direct-match", async () => {
          const { data: jds } = await admin.from("journey_definitions").select("id, name, trigger_intent, match_patterns")
            .eq("workspace_id", wsId).eq("is_active", true);
          const msgLower = msg.toLowerCase().replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/[\u2018\u2019'`]/g, "").replace(/\s+/g, " ").trim();
          const subjectLower = (st.subject || "").toLowerCase().replace(/[\u2018\u2019'`]/g, "").replace(/\s+/g, " ").trim();
          for (const jd of jds || []) {
            const patterns = (jd.match_patterns as string[] || []);
            const matched = patterns.some(p => {
              const pLower = p.toLowerCase().replace(/[''`]/g, "");
              return msgLower.includes(pLower) || subjectLower.includes(pLower);
            });
            if (matched) {
              await sysNote(admin, tid, `[System] Direct journey match → ${jd.name}`);
              return { hit: true, type: "journey" as const, id: jd.id, name: jd.name, intent: jd.trigger_intent || "" };
            }
          }
          return { hit: false } as { hit: false };
        })
      : { hit: false } as { hit: false };

    if (journeyDirect.hit) {
      const jd = journeyDirect as { hit: true; type: "journey"; id: string; name: string; intent: string };
      const pDelay = await step.run("jdirect-delay", () => responseDelay(admin, wsId, st.ch, st.custEmail));
      if (pDelay > 0) await step.sleep("jdirect-sleep", `${pDelay}s`);
      await step.run("exec-jdirect", async () => {
        if (await newerActivity(admin, tid, t0)) return;
        const { data: t } = await admin.from("tickets").select("customer_id").eq("id", tid).single();
        const { leadIn, ctaText } = await generateJourneyLeadIn(msg, jd.name, st.ch, pers);
        await launchJourneyForTicket({
          workspaceId: wsId, ticketId: tid, customerId: t?.customer_id || "",
          journeyId: jd.id, journeyName: jd.name,
          triggerIntent: jd.intent, channel: st.ch, leadIn, ctaText,
        });
        await addTicketTag(tid, `j:${jd.intent || jd.name.toLowerCase().replace(/\s+/g, "_")}`);
        await markFirstTouch(tid, "journey");
        await setStatus(admin, tid, cfg.auto_resolve);
      });
      return { status: "journey_direct_match", journey: jd.name };
    }

    if (pmatch.hit && pmatch.tag && st.hasCust && st.ch !== "social_comments") {
      const patternRouted = await step.run("route-pattern", async () => {
        // Journey?
        const { data: j } = await admin.from("journey_definitions").select("id, name, trigger_intent")
          .eq("workspace_id", wsId).eq("is_active", true);
        for (const jd of j || []) {
          const intentMatch = jd.trigger_intent && pmatch.cat?.toLowerCase().includes(jd.trigger_intent.toLowerCase());
          if (intentMatch) {
            await sysNote(admin, tid, `[System] Pattern → Journey: ${jd.name}`);
            return { type: "journey" as const, id: jd.id, name: jd.name, intent: jd.trigger_intent || pmatch.cat! };
          }
        }
        // Workflow?
        const { data: w } = await admin.from("workflows").select("id, name, trigger_tag")
          .eq("workspace_id", wsId).eq("enabled", true).eq("trigger_tag", pmatch.tag!);
        if (w?.length) {
          await sysNote(admin, tid, `[System] Pattern → Workflow: ${w[0].name}`);
          return { type: "workflow" as const, id: w[0].id, name: w[0].name, intent: pmatch.cat! };
        }
        return null;
      });

      if (patternRouted) {
        const pDelay = await step.run("pattern-delay-calc", () => responseDelay(admin, wsId, st.ch, st.custEmail));
        if (pDelay > 0) await step.sleep("pattern-delay", `${pDelay}s`);
        await step.run("exec-pattern", async () => {
          if (await newerActivity(admin, tid, t0)) return;
          if (patternRouted.type === "journey") {
            const { data: t } = await admin.from("tickets").select("customer_id").eq("id", tid).single();
            const { leadIn, ctaText } = await generateJourneyLeadIn(msg, patternRouted.name, st.ch, pers);
            await launchJourneyForTicket({
              workspaceId: wsId, ticketId: tid, customerId: t?.customer_id || "",
              journeyId: patternRouted.id, journeyName: patternRouted.name,
              triggerIntent: patternRouted.intent, channel: st.ch, leadIn, ctaText,
            });
          } else {
            const { executeWorkflow } = await import("@/lib/workflow-executor");
            await executeWorkflow(wsId, tid, pmatch.tag!);
            await addTicketTag(tid, `w:${patternRouted.name.toLowerCase().replace(/\s+/g, "_")}`);
            await markFirstTouch(tid, "workflow");
            await admin.from("tickets").update({ ai_clarification_turn: 0 }).eq("id", tid);
          }
          await setStatus(admin, tid, cfg.auto_resolve);
        });
        return { status: "pattern_routed", type: patternRouted.type, name: patternRouted.name };
      }
    }

    // ── 6. AI classify (Haiku) ──
    const ai = await step.run("classify", async () => {
      const ctx = await assembleTicketContext(wsId, tid);
      const custCtx = ctx.systemPrompt.split("CUSTOMER CONTEXT:")[1]?.split("CHANNEL")[0]?.trim() || "";
      const hist = ctx.conversationHistory.map(m => `${m.role}: ${m.content}`).join("\n");
      const hNames = await handlerNames(admin, wsId, st.hasCust, st.ch);
      const intent = await classifyIntent(msg, custCtx, hist, hNames);
      await sysNote(admin, tid, `[System] Intent: "${intent.intent}" (${intent.confidence}%). Threshold: ${cfg.threshold}%`);
      await admin.from("tickets").update({ ai_detected_intent: intent.intent, ai_intent_confidence: intent.confidence }).eq("id", tid);
      return { intent: intent.intent as string, confidence: intent.confidence as number, custCtx, hNames };
    });

    // No customer + account-related → ask for ID
    if (!st.hasCust && isAccountRelated(ai.intent)) {
      await step.run("ask-customer-id", async () => {
        await sysNote(admin, tid, `[System] Account-related but no customer. Asking for email/order number.`);
        await admin.from("tickets").update({ ai_clarification_turn: 1 }).eq("id", tid);
        const delay = await responseDelay(admin, wsId, st.ch, st.custEmail);
        if (delay > 0) await new Promise(r => setTimeout(r, delay * 1000));
        if (await newerActivity(admin, tid, t0)) return;
        await sendWithDelay(admin, wsId, tid, st.ch, "I'd be happy to help! Could you share the email address or order number associated with your account so I can pull up your details?", cfg.sandbox);
        await setStatus(admin, tid, cfg.auto_resolve);
      });
      return { status: "asking_customer" };
    }

    // Bypass confidence gate if intent matches a journey or workflow — they have their own confirmation flows
    if (ai.confidence < cfg.threshold && ai.confidence >= 60 && st.hasCust) {
      const intentBypass = await step.run("check-intent-handler", async () => {
        // Check journeys
        const { data: jds } = await admin.from("journey_definitions").select("id, name, trigger_intent")
          .eq("workspace_id", wsId).eq("is_active", true);
        for (const j of jds || []) {
          if (j.trigger_intent && ai.intent.toLowerCase().includes(j.trigger_intent.toLowerCase())) {
            return { bypass: true, handler: `Journey: ${j.name}` };
          }
        }
        // Check workflows
        const { data: wfs } = await admin.from("workflows").select("id, name, trigger_tag")
          .eq("workspace_id", wsId).eq("enabled", true);
        for (const w of wfs || []) {
          const tag = w.trigger_tag?.replace("smart:", "") || "";
          if (tag && ai.intent.toLowerCase().includes(tag.toLowerCase())) {
            return { bypass: true, handler: `Workflow: ${w.name}` };
          }
        }
        return { bypass: false, handler: "" };
      });
      if (intentBypass.bypass) {
        await step.run("intent-bypass-note", () =>
          sysNote(admin, tid, `[System] Confidence ${ai.confidence}% < ${cfg.threshold}%, but intent matches ${intentBypass.handler}. Routing directly.`));
        await step.run("route-bypass", async () => {
          await routeExec(admin, wsId, tid, st.ch, ai.intent, ai.confidence, msg, ai.custCtx, st.hasCust, cfg, pers, t0, st.custId || null, pendingAccountLink, st.custEmail);
        });
        return { status: "intent_bypass_routed", intent: ai.intent, confidence: ai.confidence };
      }
    }

    // Confidence gate
    if (ai.confidence < cfg.threshold) {
      await step.run("start-clarify", async () => {
        await sysNote(admin, tid, `[System] Confidence ${ai.confidence}% < ${cfg.threshold}%. Clarifying.`);
        await admin.from("tickets").update({ ai_clarification_turn: 1 }).eq("id", tid);
        const q = await clarifyQ(msg, ai.intent, ai.confidence, st.ch, pers);
        const delay = await responseDelay(admin, wsId, st.ch, st.custEmail);
        if (delay > 0) await new Promise(r => setTimeout(r, delay * 1000));
        if (await newerActivity(admin, tid, t0)) return;
        await sendWithDelay(admin, wsId, tid, st.ch, q, cfg.sandbox);
        await setStatus(admin, tid, cfg.auto_resolve);
      });
      return { status: "clarify_started", confidence: ai.confidence };
    }

    // ── 7. Route ──
    await step.run("route", async () => {
      await routeExec(admin, wsId, tid, st.ch, ai.intent, ai.confidence, msg, ai.custCtx, st.hasCust, cfg, pers, t0, st.custId || null, pendingAccountLink, st.custEmail);
    });
    return { status: "routed", intent: ai.intent, confidence: ai.confidence };
    ── END OLD PIPELINE ── */
    } catch (e) {
      __ctOk = false;
      throw e;
    } finally {
      await emitReactiveHeartbeat("unified-ticket-handler", { ok: __ctOk });
    }
  },
);

// ══════════════════════════════════════════════════
// ── ROUTE & EXECUTE ──
// ══════════════════════════════════════════════════

async function routeExec(
  admin: Admin, wsId: string, tid: string, ch: string,
  intent: string, conf: number, msg: string, custCtx: string,
  hasCust: boolean, cfg: { auto_resolve: boolean; sandbox: boolean },
  pers: { name?: string; tone?: string; sign_off?: string | null } | null, t0: string,
  custId?: string | null,
  pendingAccountLink?: { journeyId: string; journeyName: string } | null,
  custEmail?: string | null,
) {
  const social = ch === "social_comments";
  await admin.from("tickets").update({ ai_clarification_turn: 0 }).eq("id", tid);
  const delay = await responseDelay(admin, wsId, ch, custEmail);

  // 1. Journey
  if (hasCust && !social) {
    const { data: jds } = await admin.from("journey_definitions").select("id, name, trigger_intent, match_patterns").eq("workspace_id", wsId).eq("is_active", true);
    for (const j of jds || []) {
      const iMatch = j.trigger_intent && intent.toLowerCase().includes(j.trigger_intent.toLowerCase());
      const pMatch = (j.match_patterns as string[] || []).some((p: string) => msg.toLowerCase().includes(p.toLowerCase()));
      if (iMatch || pMatch) {
        await sysNote(admin, tid, `[System] → Journey: ${j.name} (${conf}%)`);
        if (delay > 0) await new Promise(r => setTimeout(r, delay * 1000));
        if (await newerActivity(admin, tid, t0)) return;
        const { data: t } = await admin.from("tickets").select("customer_id").eq("id", tid).single();
        const { leadIn, ctaText } = await generateJourneyLeadIn(msg, j.name, ch, pers);
        await launchJourneyForTicket({
          workspaceId: wsId, ticketId: tid, customerId: t?.customer_id || "",
          journeyId: j.id, journeyName: j.name, triggerIntent: j.trigger_intent || intent,
          channel: ch, leadIn, ctaText,
        });
        await setStatus(admin, tid, cfg.auto_resolve);
        return;
      }
    }
  }

  // 2. Playbook
  if (hasCust && !social) {
    // Matcher-defer guard (playbook-compiler-loop § Phase 3 —
    // matcher-defers-on-uncertainty). Below DEFER_THRESHOLD (DB-driven, default
    // 0.65) the matcher returns null and we fall through to Sonnet —
    // "not sure → interpret" beats "guess a wrong playbook and step through it".
    const deferThreshold = await loadDeferThreshold(admin, wsId);
    const scored = await matchPlaybookScored(admin, wsId, intent, msg);
    const gated = applyDeferThreshold(scored, deferThreshold);
    let pbMatch: { id: string; name: string } | null = gated;
    if (!gated && scored) {
      // Log the exact string the spec-test verification asserts on:
      // '[playbook] deferred: top_score X < Y'.
      console.log(`[playbook] deferred: top_score ${scored.score.toFixed(2)} < ${deferThreshold.toFixed(2)}`);
      pbMatch = null;
    }
    // Legacy fall-through: if the scored matcher found nothing (workspaces
    // whose playbooks don't score by our formula), fall back to the boolean
    // matcher so we don't regress existing behavior.
    if (!scored) pbMatch = await matchPlaybook(admin, wsId, intent, msg);
    if (pbMatch) {
      await sysNote(admin, tid, `[System] → Playbook: ${pbMatch.name} (${conf}%)`);
      await startPlaybook(admin, tid, pbMatch.id);
      await addTicketTag(tid, `pb:${pbMatch.name.toLowerCase().replace(/\s+/g, "_")}`);
      await markFirstTouch(tid, "ai");

      // Execute first step immediately
      // delay moved to send()
      if (await newerActivity(admin, tid, t0)) return;
      const result = await executePlaybookStep(wsId, tid, msg, pers);
      if (result.systemNote) await sysNote(admin, tid, result.systemNote);
      if (result.response) await sendWithDelay(admin, wsId, tid, ch, result.response, cfg.sandbox);
      // Always honor auto-resolve setting
      await setStatus(admin, tid, cfg.auto_resolve);
      return;
    }
  }

  // 3. Workflow
  if (hasCust && !social) {
    const { data: wfs } = await admin.from("workflows").select("id, name, trigger_tag").eq("workspace_id", wsId).eq("enabled", true);
    for (const w of wfs || []) {
      const tagIntent = (w.trigger_tag || "").replace("smart:", "").replace(/-/g, "_");
      if (tagIntent && intent.toLowerCase().includes(tagIntent)) {
        await sysNote(admin, tid, `[System] → Workflow: ${w.name} (${conf}%)`);
        if (delay > 0) await new Promise(r => setTimeout(r, delay * 1000));
        if (await newerActivity(admin, tid, t0)) return;
        const { executeWorkflow } = await import("@/lib/workflow-executor");
        await executeWorkflow(wsId, tid, w.trigger_tag);
        await addTicketTag(tid, `w:${w.name.toLowerCase().replace(/\s+/g, "_")}`);
        await markFirstTouch(tid, "workflow");
        await setStatus(admin, tid, cfg.auto_resolve);
        return;
      }
    }
  }

  // 3. Macro (via pattern matcher)
  const pmatch = await matchPatterns(wsId, null, msg);
  if (pmatch && pmatch.confidence >= 0.6) {
    const { data: macros } = await admin.from("macros").select("id, name, body_html, body_text").eq("workspace_id", wsId);
    const macro = (macros || []).find(m => m.name.toLowerCase() === pmatch.name.toLowerCase())
      || (macros || []).find(m => m.name.toLowerCase().includes(pmatch.name.toLowerCase()));
    if (macro) {
      await sysNote(admin, tid, `[System] → Macro: ${macro.name} (${conf}%)`);
      const text = await personalizeMacroText(macro.body_html || macro.body_text, custCtx, msg, ch, pers);
      if (await newerActivity(admin, tid, t0)) return;
      await sendWithDelay(admin, wsId, tid, ch, text, cfg.sandbox);
      await markFirstTouch(tid, "ai");
      await setStatus(admin, tid, cfg.auto_resolve);
      // Non-blocking account linking: mention it casually after answering
      if (pendingAccountLink && custId) {
        await launchJourneyForTicket({
          workspaceId: wsId, ticketId: tid, customerId: custId,
          journeyId: pendingAccountLink.journeyId, journeyName: pendingAccountLink.journeyName,
          triggerIntent: "account_linking", channel: ch,
          leadIn: "By the way, I noticed you may have another account with us. When you get a chance, linking them helps us serve you better.",
          ctaText: "Link My Accounts",
        });
        pendingAccountLink = null;
      }
      return;
    }
  }

  // 4. KB + Macro embedding fallback
  const rag = await retrieveContext(wsId, msg, 3);

  // 4a. Macro via embedding match (higher priority than KB chunks)
  if (rag.macros?.length && rag.macros[0].similarity > 0.65) {
    const bestMacro = rag.macros[0];
    await sysNote(admin, tid, `[System] → Macro (embedding): "${bestMacro.name}" (${(bestMacro.similarity * 100).toFixed(0)}%)`);
    const { data: macroFull } = await admin.from("macros").select("id, name, body_html, body_text").eq("id", bestMacro.id).single();
    if (macroFull) {
      const text = await personalizeMacroText(macroFull.body_html || macroFull.body_text, custCtx, msg, ch, pers);
      if (await newerActivity(admin, tid, t0)) return;
      await sendWithDelay(admin, wsId, tid, ch, text, cfg.sandbox);
      await markFirstTouch(tid, "ai");
      await setStatus(admin, tid, cfg.auto_resolve);
      if (pendingAccountLink && custId) {
        await launchJourneyForTicket({
          workspaceId: wsId, ticketId: tid, customerId: custId,
          journeyId: pendingAccountLink.journeyId, journeyName: pendingAccountLink.journeyName,
          triggerIntent: "account_linking", channel: ch,
          leadIn: "By the way, I noticed you may have another account with us. When you get a chance, linking them helps us serve you better.",
          ctaText: "Link My Accounts",
        });
      }
      return;
    }
  }

  // 4b. KB article fallback
  if (rag.chunks?.length && rag.chunks[0].similarity > 0.7) {
    const c = rag.chunks[0];
    await sysNote(admin, tid, `[System] → KB: "${c.kb_title}" (${conf}%). Missing macro — notified.`);
    await admin.from("dashboard_notifications").insert({
      workspace_id: wsId, type: "knowledge_gap",
      title: `Missing macro: ${intent}`, body: `KB "${c.kb_title}" used. Create a macro.`,
      metadata: { intent, ticket_id: tid },
    });
    const text = await kbResponse(c.chunk_text, c.kb_title || "", msg, ch, pers);
    if (await newerActivity(admin, tid, t0)) return;
    await sendWithDelay(admin, wsId, tid, ch, text, cfg.sandbox);
    await markFirstTouch(tid, "ai");
    await setStatus(admin, tid, cfg.auto_resolve);
    if (pendingAccountLink && custId) {
      await launchJourneyForTicket({
        workspaceId: wsId, ticketId: tid, customerId: custId,
        journeyId: pendingAccountLink.journeyId, journeyName: pendingAccountLink.journeyName,
        triggerIntent: "account_linking", channel: ch,
        leadIn: "By the way, I noticed you may have another account with us. When you get a chance, linking them helps us serve you better.",
        ctaText: "Link My Accounts",
      });
      pendingAccountLink = null;
    }
    return;
  }

  // 5. Escalate
  await escalate(admin, wsId, tid, ch, intent, conf, msg, custCtx);
}
