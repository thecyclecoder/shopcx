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

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { assembleTicketContext } from "@/lib/ai-context";
import { retrieveContext } from "@/lib/rag";
import { matchPatterns } from "@/lib/pattern-matcher";
import { sendTicketReply } from "@/lib/email";
import { addTicketTag } from "@/lib/ticket-tags";
import { markFirstTouch } from "@/lib/first-touch";
import { launchJourneyForTicket, nudgeJourney } from "@/lib/journey-delivery";
import { matchPlaybook, startPlaybook, executePlaybookStep, type PlaybookExecResult } from "@/lib/playbook-executor";

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
  const c = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase()
    .split(/(?:sent from|get outlook|on .+ wrote:|from:|----)/)[0].trim();
  return c.split(/\s+/).length <= 50 && POSITIVE_PHRASES.some(p => c.includes(p));
}

function isAccountRelated(intent: string): boolean {
  return ["order", "subscription", "cancel", "billing", "refund", "return", "exchange",
    "address", "payment", "account", "delivery", "shipping", "tracking"]
    .some(k => intent.toLowerCase().includes(k));
}

async function channelCfg(admin: Admin, wsId: string, ch: string) {
  const { data } = await admin.from("ai_channel_config")
    .select("enabled, confidence_threshold, auto_resolve, sandbox, personality_id, instructions, ai_turn_limit")
    .eq("workspace_id", wsId).eq("channel", ch).single();
  return {
    enabled: data?.enabled ?? true,
    threshold: (data?.confidence_threshold ?? 0.7) <= 1 ? Math.round((data?.confidence_threshold ?? 0.7) * 100) : (data?.confidence_threshold ?? 70),
    auto_resolve: data?.auto_resolve ?? false, sandbox: data?.sandbox ?? true,
    personality_id: data?.personality_id || null,
  };
}

async function loadPersonality(admin: Admin, pid: string | null) {
  if (!pid) return null;
  const { data } = await admin.from("ai_personalities")
    .select("name, tone, style_instructions, sign_off, greeting, emoji_usage").eq("id", pid).single();
  return data;
}

async function responseDelay(admin: Admin, wsId: string, ch: string): Promise<number> {
  const { data } = await admin.from("workspaces").select("response_delays").eq("id", wsId).single();
  const d = (data?.response_delays || { email: 60, chat: 5, sms: 10, meta_dm: 10, help_center: 5, social_comments: 10 }) as Record<string, number>;
  return d[ch] || d.email || 60;
}

async function newerActivity(admin: Admin, tid: string, since: string): Promise<boolean> {
  const { data } = await admin.from("ticket_messages").select("id")
    .eq("ticket_id", tid).or("author_type.eq.customer,author_type.eq.agent").gt("created_at", since).limit(1);
  return (data?.length || 0) > 0;
}

// ── AI ──

async function claude(prompt: string, model: "haiku" | "sonnet" = "haiku", max = 200): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "";
  const mid = model === "sonnet" ? "claude-sonnet-4-5-20250514" : "claude-haiku-4-5-20251001";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: mid, max_tokens: max, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) return "";
  const d = await r.json();
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
  const short = ["chat", "sms", "meta_dm"].includes(ch);
  const persona = p ? `Your name is ${p.name}. Tone: ${p.tone}.` : "You are a friendly support agent.";
  return (await claude(`${persona} Never reveal AI. Customer: "${msg}". Guess: "${intent}" (${conf}%). Ask ONE clarifying question. ${short ? "Max 20 words." : "Max 30 words."} Only the question.`, "haiku", 80))
    || "Could you tell me a bit more about what you need help with?";
}

async function personalizeMacroText(content: string, ctx: string, msg: string, ch: string, p: { tone?: string } | null) {
  const short = ["chat", "sms", "meta_dm"].includes(ch);
  const hasLinks = content.includes("<a ");
  return (await claude(`Lightly personalize this response. Insert customer name and relevant details from context. Do NOT make it longer. ${p?.tone ? `Tone: ${p.tone}.` : ""} ${short ? "Very short." : ""}
${hasLinks ? "IMPORTANT: Preserve ALL <a href> HTML links exactly as they appear in the original. Include them in your output." : "No markdown."}
Original: ${content}
Customer question: "${msg}"
${ctx ? `Context: ${ctx.slice(0, 300)}` : ""}
Only the personalized response, nothing else.`, "haiku", 800)) || content;
}

async function kbResponse(article: string, title: string, msg: string, ch: string, p: { tone?: string } | null) {
  const short = ["chat", "sms", "meta_dm"].includes(ch);
  return (await claude(`Answer using ONLY this KB article. Extract relevant answer. ${short ? "Max 2 sentences." : "Max 3-4 sentences."} No markdown. ${p?.tone ? `Tone: ${p.tone}.` : ""}
Question: "${msg}"
KB "${title}": ${article.slice(0, 1500)}
Only your response.`, "haiku", 500)) || article.slice(0, 500);
}

async function generateJourneyLeadIn(msg: string, journeyName: string, ch: string, p: { name?: string; tone?: string } | null): Promise<{ leadIn: string; ctaText: string }> {
  const short = ["chat", "sms", "meta_dm"].includes(ch);
  const persona = p ? `Your name is ${p.name}. Tone: ${p.tone}.` : "You are a friendly support agent.";
  const raw = await claude(`${persona} Never reveal AI. Customer sent: "${msg}". You're helping them with "${journeyName}".

Write two things:
1. A brief lead-in message (${short ? "1 sentence" : "2-3 sentences"}) that acknowledges their request and lets them know you're sending a link to help them. Do NOT mention "form", "team", "specialized team", or "department". Keep it simple: "I can help you with that" or "Let me get that taken care of for you." Match their energy.
2. A CTA button label (3-5 words, action-oriented). Use "Manage Subscription" for cancel journeys, not "Cancel Orders Form".

Return JSON: { "lead_in": "...", "cta_text": "..." }`, "haiku", 150);
  try {
    const parsed = JSON.parse(raw.replace(/^```json?\n?/, "").replace(/\n?```$/, ""));
    return { leadIn: parsed.lead_in || `Let me help you with that.`, ctaText: parsed.cta_text || `${journeyName} →` };
  } catch {
    return { leadIn: `Let me help you with that.`, ctaText: `${journeyName} →` };
  }
}

async function generatePositiveClose(msg: string, ch: string, p: { name?: string; tone?: string; sign_off?: string | null } | null, autoCloseReply: string | null): Promise<string> {
  const short = ["chat", "sms", "meta_dm"].includes(ch);
  const persona = p ? `Your name is ${p.name}. Tone: ${p.tone}.` : "You are a friendly support agent.";
  const raw = await claude(`${persona} Never reveal AI. Customer sent a positive closing message: "${msg}". Write a brief, warm closing reply. ${short ? "Max 1 sentence." : "Max 2 sentences."} ${p?.sign_off ? `End with: ${p.sign_off}` : ""} Only the reply, no markdown.`, "haiku", 60);
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
        await sendTicketReply({ workspaceId: wsId, toEmail: cust.email, subject: `Re: ${t?.subject || "Your request"}`, body: html, inReplyTo: t?.email_message_id || null, agentName: "Support", workspaceName: ws?.name || "" });
      }
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
          await sendTicketReply({
            workspaceId: wsId, toEmail: cust.email,
            subject: `Re: ${t.subject || "Your chat with us"}`,
            body: html,
            inReplyTo: null, agentName: "Support", workspaceName: ws?.name || "",
          });
          await sysNote(admin, tid, `[System] Chat customer idle. Reply also sent via email to ${cust.email}.`);
        }
      }
    }
  }
}

/** Compute delay and call send() as pending if delay > 0, immediate otherwise */
async function sendWithDelay(admin: Admin, wsId: string, tid: string, ch: string, msg: string, sandbox: boolean) {
  const delay = await responseDelay(admin, wsId, ch);
  await send(admin, wsId, tid, ch, msg, sandbox, delay > 0, delay);
}

const setStatus = (admin: Admin, tid: string, autoResolve: boolean) =>
  admin.from("tickets").update({ status: autoResolve ? "closed" : "pending" }).eq("id", tid);

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
  const { data: t } = await admin.from("tickets").select("customer_id, subject, email_message_id").eq("id", tid).single();

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
  await admin.from("tickets").update({
    status: "open",
    ai_clarification_turn: 0,
    assigned_to: assignedTo,
    escalation_reason: intent || "unknown",
  }).eq("id", tid);

  if (assignedName) {
    await sysNote(admin, tid, `[System] Escalated to ${assignedName}.`);
  }

  // Always send a customer-facing message on escalation
  let escalationMsg = "I need to look into this a bit more. I'll get back to you shortly.";
  if (ch === "chat" && customerEmail) {
    escalationMsg += ` If you leave this chat, I'll send you an email at ${customerEmail}.`;
  }

  // Insert immediately — no delay on escalation messages
  await admin.from("ticket_messages").insert({
    ticket_id: tid, direction: "outbound", visibility: "external",
    author_type: "ai", body: toHtml(escalationMsg), sent_at: new Date().toISOString(),
  });

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
  { id: "unified-ticket-handler", retries: 1, concurrency: [{ limit: 1, key: "event.data.ticket_id" }], triggers: [{ event: "ticket/inbound-message" }] },
  async ({ event, step }) => {
    const { workspace_id: wsId, ticket_id: tid, message_body: msg, channel: ch, is_new_ticket: isNew } = event.data as {
      workspace_id: string; ticket_id: string; message_body: string; channel: string; is_new_ticket: boolean;
    };
    const t0 = new Date().toISOString();
    const admin = createAdminClient();

    // ── 1. Resolve ──
    const st = await step.run("resolve", async () => {
      const { data: ticket } = await admin.from("tickets")
        .select("customer_id, channel, ai_clarification_turn, handled_by, agent_intervened, subject")
        .eq("id", tid).single();
      if (!ticket) throw new Error("Ticket not found");
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
        hasCust: !!cust, custId: cust?.id || null, hasShopifyCustomer,
        ch: ticket.channel || ch, turn: ticket.ai_clarification_turn || 0,
        intervened: !!ticket.agent_intervened, handledBy: ticket.handled_by || "",
        subject: ticket.subject || "",
      };
    });

    if (st.intervened) return { status: "skipped", reason: "agent_intervened" };

    const cfg = await step.run("config", () => channelCfg(admin, wsId, st.ch));
    if (!cfg.enabled) return { status: "skipped", reason: "ai_disabled" };
    const pers = await step.run("personality", () => loadPersonality(admin, cfg.personality_id));

    // ── 1b. General vs Account classification (Haiku) ──
    const msgType = await step.run("classify-general-account", async () => {
      const cleanMsg = msg.replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
      // Check if this is a system re-trigger (from journey completion, playbook resume, etc.)
      if (["address_confirmed", "items_selected", "playbook-apply"].includes(cleanMsg)) return "account";

      const check = await claude(
        `Classify this customer message as either "account" or "general".
- "account" = needs customer account data: refund, cancel, order status, subscription, billing, shipping, missing order, exchange, return, address change, payment issues, login, account access, coupon check, delivery status
- "general" = can be answered without account data: product questions, ingredients, how to use, pricing, availability, store hours, general company info, do you have discounts/coupons

Customer message: "${cleanMsg}"

Respond with EXACTLY one word: "account" or "general"`, "haiku", 10);
      return (check || "").toLowerCase().trim().includes("general") ? "general" : "account";
    });

    if (isNew) await sysNote(admin, tid, `[System] Classification: ${msgType}`);

    let pendingAccountLink: { journeyId: string; journeyName: string } | null = null;

    // ── 2. Account path: linking + Shopify customer check ──
    if (msgType === "account" && st.hasCust && isNew) {
      // 2a. Always check for unlinked accounts (need full context for account work)
      const linkResult = await step.run("check-linking", async () => {
        const { findUnlinkedMatches } = await import("@/lib/account-matching");
        const unlinked = await findUnlinkedMatches(wsId, st.custId!, admin);
        if (!unlinked.length) return { hasUnlinked: false, launched: false };

        const { data: jd } = await admin.from("journey_definitions").select("id, name").eq("workspace_id", wsId).eq("trigger_intent", "account_linking").eq("is_active", true).limit(1).single();
        if (!jd) return { hasUnlinked: true, launched: false };

        await sysNote(admin, tid, `[System] Unlinked accounts found. Launching account linking for full context.`);
        const linkLeadIn = "I've got your request. It looks like you may have more than one profile in our system. Please link your accounts so I can pull up your full information and help you right away.";
        await launchJourneyForTicket({
          workspaceId: wsId, ticketId: tid, customerId: st.custId!,
          journeyId: jd.id, journeyName: jd.name, triggerIntent: "account_linking",
          channel: st.ch, leadIn: linkLeadIn, ctaText: "Link My Accounts",
        });
        await setStatus(admin, tid, cfg.auto_resolve);
        return { hasUnlinked: true, launched: true };
      });

      if (linkResult.launched) return { status: "account_linking" };

      // 2b. No Shopify customer → conversational inline flow
      if (!st.hasShopifyCustomer) {
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
              return { status: "awaiting_email_confirm" };
            } else {
              // Email found but no Shopify customer
              await sendWithDelay(admin, wsId, tid, st.ch,
                "I found that email but don't see any orders associated with it. Could you try the email you used when placing your order?", cfg.sandbox);
              return { status: "awaiting_alternate_email" };
            }
          } else {
            // No email found in message
            await sendWithDelay(admin, wsId, tid, st.ch,
              "I didn't catch an email address. Could you share the email you used when placing your order?", cfg.sandbox);
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
        return { status: "no_shopify_customer" };
      }
    }

    // ── 2c. General path with unlinked accounts → mention casually after answering
    if (msgType === "general" && st.hasCust && isNew) {
      const casualLink = await step.run("check-casual-linking", async () => {
        const { findUnlinkedMatches } = await import("@/lib/account-matching");
        const unlinked = await findUnlinkedMatches(wsId, st.custId!, admin);
        if (!unlinked.length) return null;
        const { data: jd } = await admin.from("journey_definitions").select("id, name").eq("workspace_id", wsId).eq("trigger_intent", "account_linking").eq("is_active", true).limit(1).single();
        if (!jd) return null;
        return { journeyId: jd.id, journeyName: jd.name };
      });
      if (casualLink) pendingAccountLink = casualLink;
    }

    // ── 2e. Crisis short-circuit — skip pattern match if this is a crisis ticket ──
    // Crisis follow-up detection runs later (step 2d) but we need to prevent the
    // early pattern match from stealing the message first
    let isCrisisTicket = false;
    if (!isNew && st.hasCust) {
      const crisisTags = await step.run("crisis-tag-check", async () => {
        const { data: t } = await admin.from("tickets").select("tags").eq("id", tid).single();
        return ((t?.tags as string[]) || []).some(tag => tag.startsWith("crisis"));
      });
      isCrisisTicket = crisisTags;
    }

    // ── 3. Early pattern match — runs before re-nudge/playbook checks ──
    // For account messages: check journeys/playbooks/workflows
    // SKIP for crisis tickets — those are handled by the crisis follow-up block
    // For general messages: only check for macros (pattern_only)
    if (!isCrisisTicket) {
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

      // Clear handled_by so this routes fresh
      await step.run("clear-handled-by", () =>
        admin.from("tickets").update({ handled_by: null, ai_clarification_turn: 0 }).eq("id", tid));

      if (ep.type === "journey" && st.hasCust) {
        const delay = await step.run("ep-delay", () => responseDelay(admin, wsId, st.ch));
        // delay handled by sendWithDelay
        await step.run("ep-journey", async () => {
          if (await newerActivity(admin, tid, t0)) return;
          const { leadIn, ctaText } = await generateJourneyLeadIn(msg, ep.name, st.ch, pers);
          await launchJourneyForTicket({
            workspaceId: wsId, ticketId: tid, customerId: st.custId!,
            journeyId: ep.id, journeyName: ep.name, triggerIntent: ep.intent || "",
            channel: st.ch, leadIn, ctaText,
          });
          await admin.from("tickets").update({ handled_by: `Journey: ${ep.name}` }).eq("id", tid);
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
          await admin.from("tickets").update({ handled_by: `Playbook: ${ep.name}` }).eq("id", tid);
        });
        // Execute first step
        const delay = await step.run("ep-pb-delay", () => responseDelay(admin, wsId, st.ch));
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
          const delay = await step.run("ep-wf-delay", () => responseDelay(admin, wsId, st.ch));
          if (delay > 0) await step.sleep("ep-wf-sleep", `${delay}s`);
          await step.run("ep-exec-workflow", async () => {
            if (await newerActivity(admin, tid, t0)) return;
            const { executeWorkflow } = await import("@/lib/workflow-executor");
            await executeWorkflow(wsId, tid, wfTag);
            await addTicketTag(tid, `w:${ep.name.toLowerCase().replace(/\s+/g, "_")}`);
            await admin.from("tickets").update({ handled_by: `Workflow: ${ep.name}`, ai_clarification_turn: 0 }).eq("id", tid);
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
          await routeExec(admin, wsId, tid, st.ch, ep.intent, Math.round(ep.confidence * 100), msg, custCtx, st.hasCust, cfg, pers, t0, st.custId || null, pendingAccountLink);
        });
        return { status: "early_pattern_macro", intent: ep.intent };
      }
    }
    } // end !isCrisisTicket

    // ── 2d. Crisis follow-up detection ──
    // If this ticket was handled by a crisis and the customer replies, detect intent and re-launch journey
    if (!isNew && st.hasCust) {
      const crisisFollowup = await step.run("check-crisis-followup", async () => {
        const { data: ticket } = await admin.from("tickets")
          .select("tags, handled_by").eq("id", tid).single();
        const tags = (ticket?.tags as string[]) || [];
        const isCrisisTicket = tags.some(t => t.startsWith("crisis"));
        if (!isCrisisTicket) return null;

        // Find the crisis action for this customer
        const { data: action } = await admin.from("crisis_customer_actions")
          .select("id, crisis_id, subscription_id, segment, current_tier, tier1_response, tier2_response")
          .eq("ticket_id", tid)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!action) return null;

        // Get crisis details for context
        const { data: crisis } = await admin.from("crisis_events")
          .select("id, name, affected_product_title, default_swap_title, available_flavor_swaps, available_product_swaps, status")
          .eq("id", action.crisis_id)
          .single();
        if (!crisis || crisis.status === "resolved") return null;

        // Build available options for Haiku context
        const flavorNames = [crisis.default_swap_title, ...((crisis.available_flavor_swaps as { title: string }[]) || []).map(f => f.title)].filter(Boolean);
        const productNames = ((crisis.available_product_swaps as { productTitle: string }[]) || []).map(p => p.productTitle);

        // Use Haiku to classify the customer's intent
        const cleanMsg = msg.replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
        const intentCheck = await claude(
          `A customer is replying to a crisis outreach about "${crisis.affected_product_title}" being out of stock.
Their subscription was auto-swapped to "${crisis.default_swap_title}".
Available flavor swaps: ${flavorNames.join(", ")}.
Available product swaps: ${productNames.join(", ")}.
Current status: ${action.tier1_response === "accepted_swap" ? "They already accepted a flavor swap" : "Pending response"}.
If the customer mentions ANY product or action related to their subscription (even products from the swap list), classify it as crisis-related.

Classify their message into one of these intents:
- "change_flavor" — wants to switch to a different flavor of the same product
- "change_product" — wants a completely different product instead
- "pause" — wants to pause their subscription until the product is back
- "remove_item" — wants to remove the affected item but keep the rest of their subscription
- "cancel" — wants to cancel their subscription entirely
- "question" — asking a question about the crisis or their subscription
- "other" — something unrelated

Customer message: "${cleanMsg}"

Respond with EXACTLY one word.`, "haiku", 20);
        const intent = (intentCheck || "other").toLowerCase().trim();

        return { intent, actionId: action.id, crisisId: action.crisis_id, subscriptionId: action.subscription_id, segment: action.segment, currentTier: action.current_tier, tier1Response: action.tier1_response };
      });

      if (crisisFollowup && crisisFollowup.intent !== "question" && crisisFollowup.intent !== "other") {
        // Direct action execution — parse full request with Sonnet and execute
        const delay = await step.run("crisis-direct-delay", () => responseDelay(admin, wsId, st.ch));
        if (delay > 0) await step.sleep("crisis-direct-wait", `${delay}s`);

        const crisisResult = await step.run("crisis-direct-action", async () => {
          if (await newerActivity(admin, tid, t0)) return { status: "bailed" as const };

          // Load full crisis context
          const { data: crisis } = await admin.from("crisis_events")
            .select("id, affected_product_title, affected_variant_id, default_swap_variant_id, default_swap_title, available_flavor_swaps, available_product_swaps, tier2_coupon_code, tier2_coupon_percent")
            .eq("id", crisisFollowup.crisisId).single();
          if (!crisis) return { status: "no_crisis" as const };

          // Load subscription details
          const { data: sub } = await admin.from("subscriptions")
            .select("shopify_contract_id, items, status")
            .eq("id", crisisFollowup.subscriptionId).single();
          if (!sub?.shopify_contract_id) return { status: "no_sub" as const };
          const contractId = sub.shopify_contract_id;

          // Build available options for Sonnet
          const flavorOptions = [
            { variantId: crisis.default_swap_variant_id, title: crisis.default_swap_title },
            ...((crisis.available_flavor_swaps as { variantId: string; title: string }[]) || []),
          ];
          const productOptions = ((crisis.available_product_swaps as { productTitle: string; variants: { variantId: string; title: string }[] }[]) || []);

          // Determine what's currently on the subscription (may have been auto-swapped)
          const { data: action } = await admin.from("crisis_customer_actions")
            .select("tier1_swapped_to, tier2_swapped_to, original_item")
            .eq("id", crisisFollowup.actionId).single();
          const currentVariant = (action?.tier2_swapped_to as { variantId?: string })?.variantId
            || (action?.tier1_swapped_to as { variantId?: string })?.variantId
            || crisis.default_swap_variant_id
            || crisis.affected_variant_id;

          const cleanMsg = msg.replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();

          // Sonnet action planner
          const planPrompt = `You are a subscription support agent. A customer replied to a crisis outreach about "${crisis.affected_product_title}" being out of stock.

CURRENT STATE:
- Their subscription currently has variant "${(action?.tier1_swapped_to as { title?: string })?.title || crisis.default_swap_title}" (auto-swapped from "${crisis.affected_product_title}")
- Subscription items: ${JSON.stringify(sub.items)}
- Segment: ${crisisFollowup.segment} (${crisisFollowup.segment === "berry_only" ? "only has the affected item" : "has other items too"})

AVAILABLE FLAVOR SWAPS (same product, different flavor):
${flavorOptions.map(f => `- "${f.title}" (variantId: ${f.variantId})`).join("\n")}

AVAILABLE PRODUCT SWAPS (different product entirely):
${productOptions.map(p => `- ${p.productTitle}: ${p.variants.map(v => `"${v.title}" (variantId: ${v.variantId})`).join(", ")}`).join("\n")}

COUPON: ${crisis.tier2_coupon_code ? `${crisis.tier2_coupon_percent}% off with code ${crisis.tier2_coupon_code}` : "None available"}

CUSTOMER MESSAGE: "${cleanMsg}"

Based on what the customer wants, return a JSON action plan. Available action types:
- "swap_variant": swap current variant to a new one. Requires from_variant_id, to_variant_id, to_title, and optionally quantity (default 1)
- "pause": pause the subscription until the product is back in stock
- "remove_item": remove the affected item (keep other subscription items)
- "cancel": customer wants to cancel entirely
- "apply_coupon": apply the crisis coupon code

If you can't determine exactly what the customer wants, set needs_clarification to true and write a short, friendly clarification question.

Return ONLY valid JSON:
{
  "actions": [{ "type": "...", "from_variant_id": "...", "to_variant_id": "...", "to_title": "...", "quantity": 1 }],
  "pause": false,
  "remove_item": false,
  "cancel": false,
  "needs_clarification": false,
  "clarification_question": null,
  "confirmation_summary": "short description of what was done"
}`;

          const planResult = await claude(planPrompt, "sonnet", 500);
          let plan: {
            actions: { type: string; from_variant_id?: string; to_variant_id?: string; to_title?: string; quantity?: number }[];
            pause: boolean; remove_item: boolean; cancel: boolean;
            needs_clarification: boolean; clarification_question: string | null;
            confirmation_summary: string;
          };
          try {
            const jsonMatch = planResult.match(/\{[\s\S]*\}/);
            plan = JSON.parse(jsonMatch?.[0] || "{}");
          } catch {
            plan = { actions: [], pause: false, remove_item: false, cancel: false, needs_clarification: true, clarification_question: "I want to help! Could you let me know exactly what you'd like us to do with your subscription?", confirmation_summary: "" };
          }

          await sysNote(admin, tid, `[System] Sonnet raw: ${planResult.slice(0, 300)}`);
          await sysNote(admin, tid, `[System] Crisis action plan: ${JSON.stringify(plan)}`);

          // Check sandbox mode
          const { data: wsData } = await admin.from("workspaces").select("sandbox_mode").eq("id", wsId).single();
          const isSandbox = wsData?.sandbox_mode === true;

          // Treat empty/invalid plans as needing clarification
          const hasAnyAction = (plan.actions?.length > 0) || plan.pause || plan.remove_item || plan.cancel;
          if (plan.needs_clarification || !hasAnyAction) {
            await sendWithDelay(admin, wsId, tid, st.ch, plan.clarification_question || "I want to make sure I get this right for you. Could you let me know exactly what you'd like us to do with your subscription?", isSandbox);
            return { status: "clarification_sent" as const };
          }

          // Execute actions
          const executed: string[] = [];
          const errors: string[] = [];

          if (isSandbox) {
            // Dry run — log what we would do
            if (plan.actions.length) executed.push(`[DRY RUN] Would execute: ${plan.actions.map(a => `${a.type}${a.to_title ? ` → ${a.to_title}` : ""}${a.quantity && a.quantity > 1 ? ` (qty: ${a.quantity})` : ""}`).join(", ")}`);
            if (plan.pause) executed.push("[DRY RUN] Would pause subscription, auto_resume: true");
            if (plan.remove_item) executed.push("[DRY RUN] Would remove affected item, auto_readd: true");
            if (plan.cancel) executed.push("[DRY RUN] Would cancel subscription");
            await sysNote(admin, tid, `[Crisis Dry Run] ${executed.join(". ")}`);
            await sendWithDelay(admin, wsId, tid, st.ch, `[Crisis Draft] Would: ${plan.confirmation_summary}`, true);
            return { status: "sandbox_dry_run" as const };
          }

          // Live execution
          const { subSwapVariant, subRemoveItem } = await import("@/lib/subscription-items");
          const { appstleSubscriptionAction } = await import("@/lib/appstle");

          for (const action of plan.actions || []) {
            if (action.type === "swap_variant" && action.to_variant_id) {
              const fromId = action.from_variant_id || currentVariant;
              const result = await subSwapVariant(wsId, contractId, fromId, action.to_variant_id, action.quantity || 1);
              if (result.success) {
                executed.push(`Swapped to ${action.to_title || action.to_variant_id}${action.quantity && action.quantity > 1 ? ` (qty: ${action.quantity})` : ""}`);
                await admin.from("crisis_customer_actions").update({
                  tier1_response: "accepted_swap",
                  tier1_swapped_to: { variantId: action.to_variant_id, title: action.to_title, quantity: action.quantity || 1 },
                  updated_at: new Date().toISOString(),
                }).eq("id", crisisFollowup.actionId);
              } else {
                errors.push(`Swap failed: ${result.error}`);
              }
            }
            if (action.type === "apply_coupon" && crisis.tier2_coupon_code) {
              try {
                const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
                const { getAppstleConfig } = await import("@/lib/subscription-items");
                const appstleConfig = await getAppstleConfig(wsId);
                if (appstleConfig) {
                  await applyDiscountWithReplace(appstleConfig.apiKey, contractId, crisis.tier2_coupon_code);
                  executed.push(`Applied ${crisis.tier2_coupon_percent}% coupon`);
                  await admin.from("crisis_customer_actions").update({ tier2_coupon_applied: true }).eq("id", crisisFollowup.actionId);
                }
              } catch (e) { errors.push(`Coupon failed: ${e instanceof Error ? e.message : "unknown"}`); }
            }
          }

          if (plan.pause) {
            const result = await appstleSubscriptionAction(wsId, contractId, "pause", "Crisis — customer requested pause until restock");
            if (result.success) {
              executed.push("Paused subscription (will auto-resume when back in stock)");
              await admin.from("crisis_customer_actions").update({
                tier3_response: "accepted_pause", paused_at: new Date().toISOString(), auto_resume: true, updated_at: new Date().toISOString(),
              }).eq("id", crisisFollowup.actionId);
            } else { errors.push(`Pause failed: ${result.error}`); }
          }

          if (plan.remove_item) {
            const removeVariant = crisis.affected_variant_id || currentVariant;
            const result = await subRemoveItem(wsId, contractId, removeVariant);
            if (result.success) {
              executed.push("Removed affected item (will auto-add when back in stock)");
              await admin.from("crisis_customer_actions").update({
                tier3_response: "accepted_remove", removed_item_at: new Date().toISOString(), auto_readd: true, updated_at: new Date().toISOString(),
              }).eq("id", crisisFollowup.actionId);
            } else { errors.push(`Remove failed: ${result.error}`); }
          }

          if (plan.cancel) {
            const result = await appstleSubscriptionAction(wsId, contractId, "cancel", "Crisis — customer requested cancellation");
            if (result.success) {
              executed.push("Cancelled subscription");
              await admin.from("crisis_customer_actions").update({
                cancelled: true, cancel_date: new Date().toISOString(), updated_at: new Date().toISOString(),
              }).eq("id", crisisFollowup.actionId);
            } else { errors.push(`Cancel failed: ${result.error}`); }
          }

          if (errors.length) {
            await sysNote(admin, tid, `[System] Crisis action errors: ${errors.join("; ")}`);
            // Escalate on failure
            await sendWithDelay(admin, wsId, tid, st.ch,
              "I ran into an issue processing your request. I've flagged this for our team and someone will follow up with you shortly.", false);
            await admin.from("tickets").update({ assigned_to: null, handled_by: null }).eq("id", tid);
            return { status: "crisis_action_error" as const };
          }

          // Send confirmation
          const confirmMsg = plan.confirmation_summary || executed.join(". ");
          await sysNote(admin, tid, `[System] Crisis actions executed: ${executed.join("; ")}`);
          await sendWithDelay(admin, wsId, tid, st.ch,
            `All done! Here's what we've updated for you:\n\n${executed.map(e => `• ${e}`).join("\n")}\n\nIf you have any other questions, just reply to this email.`, false);
          await setStatus(admin, tid, cfg.auto_resolve);
          return { status: "crisis_actions_executed" as const };
        });

        if (crisisResult.status !== "bailed") {
          return { status: `crisis_direct_${crisisResult.status}` };
        }
      }

      if (crisisFollowup && (crisisFollowup.intent === "question" || crisisFollowup.intent === "other")) {
        // Let it fall through to AI — but add crisis context to the prompt
        await sysNote(admin, tid, `[System] Crisis follow-up (${crisisFollowup.intent}). Routing to AI with crisis context.`);
        // Fall through to normal AI pipeline
      }
    }

    // ── 3. Journey/playbook re-nudge with conversation drift detection ──
    if (!isNew && st.handledBy?.startsWith("Journey:")) {
      const nudged = await step.run("check-journey-nudge", async () => {
        const { data: ticketData } = await admin.from("tickets").select("journey_history").eq("id", tid).single();
        const history = (ticketData?.journey_history as { journey_id: string; journey_name: string; nudged_at: string | null; completed: boolean }[]) || [];
        const activeJourney = history.find(h => !h.completed);
        if (!activeJourney) return null;

        // ── Drift detection: check if the customer's message is about something else ──
        const cleanMsg = msg.replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
        const driftCheck = await claude(
          `You are detecting conversation drift. A customer has an active journey/flow ("${activeJourney.journey_name}") but just sent a new message.
Determine if their message is:
- "drift" — asking about something completely unrelated to the active flow (e.g. product questions, new topic, general inquiry)
- "related" — responding to or about the active flow (e.g. completing it, asking about it, confused about it, saying they did it)

Customer message: "${cleanMsg}"

Respond with EXACTLY one word: "drift" or "related"`, "haiku", 30);
        const isDrift = (driftCheck || "").toLowerCase().trim().includes("drift");

        if (isDrift) {
          await sysNote(admin, tid, `[System] Conversation drift detected — customer asked about something unrelated to "${activeJourney.journey_name}". Answering question first.`);
          return { action: "drift" as const, entry: activeJourney };
        }

        if (!activeJourney.nudged_at) {
          await sysNote(admin, tid, `[System] Customer replied without completing journey "${activeJourney.journey_name}". Re-nudging.`);
          return { action: "nudge" as const, entry: activeJourney };
        } else {
          await sysNote(admin, tid, `[System] Customer declined journey "${activeJourney.journey_name}" after re-nudge. Escalating.`);
          await admin.from("tickets").update({ status: "open", ai_clarification_turn: 0 }).eq("id", tid);
          return { action: "escalate" as const, entry: activeJourney };
        }
      });

      if (nudged?.action === "drift") {
        // Answer the question via normal AI pipeline, then gently nudge back
        // Fall through to the AI draft pipeline below — it will generate a response
        // After answering, add a nudge reminder
        await sysNote(admin, tid, `[System] Drift: answering customer question, then will nudge back to "${nudged.entry.journey_name}".`);
        // Don't return — let it fall through to normal AI processing
      } else if (nudged?.action === "nudge") {
        const delay = await step.run("nudge-delay", () => responseDelay(admin, wsId, st.ch));
        if (delay > 0) await step.sleep("nudge-wait", `${delay}s`);
        await step.run("send-nudge", async () => {
          if (await newerActivity(admin, tid, t0)) return;
          await nudgeJourney(wsId, tid, nudged.entry, st.ch, msg, pers);
        });
        return { status: "journey_renudged", journey: nudged.entry.journey_name };
      } else if (nudged?.action === "escalate") {
        return { status: "escalated", reason: "journey_declined" };
      }
    }

    // ── 3b. Active playbook — skip normal pipeline, execute next step ──
    if (!isNew) {
      const pbActive = await step.run("check-playbook", async () => {
        const { data: t } = await admin.from("tickets").select("active_playbook_id").eq("id", tid).single();
        return t?.active_playbook_id || null;
      });

      if (pbActive) {
        const delay = await step.run("playbook-delay", () => responseDelay(admin, wsId, st.ch));
        // delay handled by sendWithDelay

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
            await sysNote(admin, tid, `[System] Playbook API failure: ${pbResult.error}. Escalating to agent.`);
            await admin.from("tickets").update({ status: "open" }).eq("id", tid);
            // Slack notification
            try {
              const { data: ws } = await admin.from("workspaces").select("slack_webhook_url").eq("id", wsId).single();
              if (ws?.slack_webhook_url) {
                const { data: pb } = await admin.from("playbooks").select("name").eq("id", pbActive).single();
                const { data: cust } = await admin.from("customers").select("email, first_name").eq("id", st.custId!).single();
                await fetch(ws.slack_webhook_url, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ text: `🚨 *Playbook Action Failed*\nPlaybook: ${pb?.name || "Unknown"}\nCustomer: ${cust?.first_name || ""} (${cust?.email || ""})\nError: ${pbResult.error}\nTicket: https://shopcx.ai/dashboard/tickets/${tid}` }),
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
      }
    }

    // ── 4. Positive close ──
    // Check on all follow-up messages (not just active handlers) — covers post-playbook "thanks"
    if (!isNew) {
      const isClose = await step.run("check-positive-close", async () => {
        return isPositive(msg);
      });

      if (isClose) {
        const delay = await step.run("close-delay", () => responseDelay(admin, wsId, st.ch));
        // delay handled by sendWithDelay
        await step.run("send-close", async () => {
          if (await newerActivity(admin, tid, t0)) return;
          const { data: ws } = await admin.from("workspaces").select("auto_close_reply").eq("id", wsId).single();
          const closing = await generatePositiveClose(msg, st.ch, pers, ws?.auto_close_reply || null);
          await sendWithDelay(admin, wsId, tid, st.ch, closing, cfg.sandbox);
          await setStatus(admin, tid, true);
          await sysNote(admin, tid, `[System] Positive close. Ticket closed.`);
        });
        return { status: "positive_close" };
      }
    }

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
            await routeExec(admin, wsId, tid, st.ch, intent, 95, msg, "", st.hasCust, cfg, pers, t0);
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
          await routeExec(admin, wsId, tid, st.ch, intent.intent, intent.confidence, msg, custCtx, st.hasCust, cfg, pers, t0);
          return { status: "routed_after_clarify", intent: intent.intent };
        }
        const next = st.turn + 1;
        await admin.from("tickets").update({ ai_clarification_turn: next }).eq("id", tid);
        if (next >= MAX_CLARIFY) {
          await escalate(admin, wsId, tid, st.ch, intent.intent, intent.confidence, msg, custCtx);
          return { status: "escalated", reason: "max_clarify" };
        }
        const q = await clarifyQ(msg, intent.intent, intent.confidence, st.ch, pers);
        const delay = await responseDelay(admin, wsId, st.ch);
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
      const pDelay = await step.run("jdirect-delay", () => responseDelay(admin, wsId, st.ch));
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
        await admin.from("tickets").update({ handled_by: `Journey: ${jd.name}` }).eq("id", tid);
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
        const pDelay = await step.run("pattern-delay-calc", () => responseDelay(admin, wsId, st.ch));
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
            await admin.from("tickets").update({ handled_by: `Workflow: ${patternRouted.name}`, ai_clarification_turn: 0 }).eq("id", tid);
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
        const delay = await responseDelay(admin, wsId, st.ch);
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
          await routeExec(admin, wsId, tid, st.ch, ai.intent, ai.confidence, msg, ai.custCtx, st.hasCust, cfg, pers, t0, st.custId || null, pendingAccountLink);
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
        const delay = await responseDelay(admin, wsId, st.ch);
        if (delay > 0) await new Promise(r => setTimeout(r, delay * 1000));
        if (await newerActivity(admin, tid, t0)) return;
        await sendWithDelay(admin, wsId, tid, st.ch, q, cfg.sandbox);
        await setStatus(admin, tid, cfg.auto_resolve);
      });
      return { status: "clarify_started", confidence: ai.confidence };
    }

    // ── 7. Route ──
    await step.run("route", async () => {
      await routeExec(admin, wsId, tid, st.ch, ai.intent, ai.confidence, msg, ai.custCtx, st.hasCust, cfg, pers, t0, st.custId || null, pendingAccountLink);
    });
    return { status: "routed", intent: ai.intent, confidence: ai.confidence };
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
) {
  const social = ch === "social_comments";
  await admin.from("tickets").update({ ai_clarification_turn: 0 }).eq("id", tid);
  const delay = await responseDelay(admin, wsId, ch);

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
    const pbMatch = await matchPlaybook(admin, wsId, intent, msg);
    if (pbMatch) {
      await sysNote(admin, tid, `[System] → Playbook: ${pbMatch.name} (${conf}%)`);
      await startPlaybook(admin, tid, pbMatch.id);
      await admin.from("tickets").update({ handled_by: `Playbook: ${pbMatch.name}` }).eq("id", tid);
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
        await admin.from("tickets").update({ handled_by: `Workflow: ${w.name}` }).eq("id", tid);
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
      await admin.from("tickets").update({ handled_by: "AI Agent" }).eq("id", tid);
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
      await admin.from("tickets").update({ handled_by: "AI Agent" }).eq("id", tid);
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
    await admin.from("tickets").update({ handled_by: "AI Agent" }).eq("id", tid);
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
