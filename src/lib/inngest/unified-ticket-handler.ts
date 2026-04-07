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
  return (await claude(`Lightly personalize. Insert name/order details. Do NOT make longer. ${p?.tone ? `Tone: ${p.tone}.` : ""} ${short ? "Very short." : ""}
Original: ${content}
Customer: "${msg}"
${ctx ? `Context: ${ctx.slice(0, 300)}` : ""}
Only the response. No markdown.`, "haiku", 300)) || content;
}

async function kbResponse(article: string, title: string, msg: string, ch: string, p: { tone?: string } | null) {
  const short = ["chat", "sms", "meta_dm"].includes(ch);
  return (await claude(`Answer using ONLY this KB article. Extract relevant answer. ${short ? "Max 2 sentences." : "Max 3-4 sentences."} No markdown. ${p?.tone ? `Tone: ${p.tone}.` : ""}
Question: "${msg}"
KB "${title}": ${article.slice(0, 1500)}
Only your response.`, "haiku", 200)) || article.slice(0, 500);
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
    const { data: t } = await admin.from("tickets").select("subject, email_message_id, customers(email)").eq("id", tid).single();
    const email = (t?.customers as unknown as { email: string })?.email;
    if (email) {
      const { data: ws } = await admin.from("workspaces").select("name").eq("id", wsId).single();
      await sendTicketReply({ workspaceId: wsId, toEmail: email, subject: `Re: ${t?.subject || "Your request"}`, body: html, inReplyTo: t?.email_message_id || null, agentName: "Support", workspaceName: ws?.name || "" });
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
    for (const x of j || []) parts.push(`Journey: ${x.name} (intent: ${x.trigger_intent || "n/a"})`);
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
  const { data: t } = await admin.from("tickets").select("customer_id").eq("id", tid).single();
  await admin.from("escalation_gaps").insert({
    workspace_id: wsId, ticket_id: tid, customer_id: t?.customer_id || null,
    channel: ch, detected_intent: intent, confidence: conf,
    original_message: msg.slice(0, 2000), customer_context_summary: ctx.slice(0, 1000),
  });
  await admin.from("dashboard_notifications").insert({
    workspace_id: wsId, type: "escalation_gap",
    title: `AI escalated: ${intent || "unknown"}`, body: `"${msg.slice(0, 100)}..."`,
    metadata: { ticket_id: tid, intent, confidence: conf },
  });
  await admin.from("tickets").update({ status: "open", ai_clarification_turn: 0 }).eq("id", tid);
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
      let cust: { id: string; email: string; first_name: string | null; phone: string | null } | null = null;
      if (ticket.customer_id) {
        const { data } = await admin.from("customers").select("id, email, first_name, phone").eq("id", ticket.customer_id).single();
        cust = data;
      }
      if (cust && isNew) await sysNote(admin, tid, `[System] Customer: ${cust.first_name || ""} (${cust.email})`);
      else if (!cust && isNew) await sysNote(admin, tid, `[System] No customer match`);
      return {
        hasCust: !!cust, custId: cust?.id || null,
        ch: ticket.channel || ch, turn: ticket.ai_clarification_turn || 0,
        intervened: !!ticket.agent_intervened, handledBy: ticket.handled_by || "",
        subject: ticket.subject || "",
      };
    });

    if (st.intervened) return { status: "skipped", reason: "agent_intervened" };

    const cfg = await step.run("config", () => channelCfg(admin, wsId, st.ch));
    if (!cfg.enabled) return { status: "skipped", reason: "ai_disabled" };
    const pers = await step.run("personality", () => loadPersonality(admin, cfg.personality_id));

    // ── 2. Account linking check ──
    // For account-related requests (refunds, cancels, orders, subscriptions): link first, then process.
    // For non-account requests (product questions, general): answer first, mention linking casually.
    let pendingAccountLink: { journeyId: string; journeyName: string } | null = null;

    if (st.hasCust && isNew) {
      const linkResult = await step.run("check-linking", async () => {
        const { findUnlinkedMatches } = await import("@/lib/account-matching");
        const unlinked = await findUnlinkedMatches(wsId, st.custId!, admin);
        if (!unlinked.length) return { hasUnlinked: false, isAccountRelated: false };

        const { data: jd } = await admin.from("journey_definitions").select("id, name").eq("workspace_id", wsId).eq("trigger_intent", "account_linking").eq("is_active", true).limit(1).single();
        if (!jd) return { hasUnlinked: false, isAccountRelated: false };

        // Quick classify: is this message account-related?
        const cleanMsg = msg.replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
        const check = await claude(
          `Classify this customer message as either "account" or "general".
- "account" = needs customer account data to answer: refund, cancel, order status, subscription, billing, shipping, missing order, exchange, return, address change, payment issues
- "general" = can be answered without account data: product questions, ingredients, how to use, pricing, availability, store hours, general company info

Customer message: "${cleanMsg}"

Respond with EXACTLY one word: "account" or "general"`, "haiku", 10);

        const isAccountRelated = !(check || "").toLowerCase().trim().includes("general");

        if (isAccountRelated) {
          // Block: link accounts first, then process
          await sysNote(admin, tid, `[System] Potential unlinked accounts (account-related request). Launching account linking first.`);
          const linkLeadIn = "I've got your request. It looks like you may have more than one profile in our system. Please click the button below to link your accounts so I can pull up your full customer information and help you right away.";
          const linkCta = "Link My Accounts";
          await launchJourneyForTicket({
            workspaceId: wsId, ticketId: tid, customerId: st.custId!,
            journeyId: jd.id, journeyName: jd.name, triggerIntent: "account_linking",
            channel: st.ch, leadIn: linkLeadIn, ctaText: linkCta,
          });
          await setStatus(admin, tid, cfg.auto_resolve);
          return { hasUnlinked: true, isAccountRelated: true, journeyId: jd.id, journeyName: jd.name };
        }

        // Non-blocking: stash for later, let the question get answered first
        await sysNote(admin, tid, `[System] Unlinked accounts found, but message is general — answering first, linking after.`);
        return { hasUnlinked: true, isAccountRelated: false, journeyId: jd.id, journeyName: jd.name };
      });

      if (linkResult.isAccountRelated) return { status: "account_linking" };
      if (linkResult.hasUnlinked && !linkResult.isAccountRelated && "journeyId" in linkResult) {
        pendingAccountLink = { journeyId: linkResult.journeyId as string, journeyName: linkResult.journeyName as string };
      }
    }

    // ── 2b. Early pattern match — runs before re-nudge/playbook checks ──
    // If the customer's message clearly matches a journey/playbook pattern,
    // skip re-nudge and route fresh (e.g. "cancel the other one" after a completed cancel journey)
    const earlyPattern = await step.run("early-pattern-match", async () => {
      const m = await matchPatterns(wsId, null, msg);
      if (m && m.confidence >= 0.7) {
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
      }
      // Also check direct journey pattern match (bypass smart patterns)
      const { data: journeys } = await admin.from("journey_definitions").select("id, name, trigger_intent, match_patterns")
        .eq("workspace_id", wsId).eq("is_active", true);
      const msgLower = msg.toLowerCase().replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/[\u2018\u2019'`]/g, "").replace(/\s+/g, " ").trim();
      for (const jd of journeys || []) {
        const patterns = (jd.match_patterns as string[] || []);
        const matched = patterns.some(p => msgLower.includes(p.toLowerCase().replace(/[''`]/g, "")));
        if (matched) return { hit: true, type: "journey" as const, id: jd.id, name: jd.name, intent: jd.trigger_intent, patternName: "direct pattern", confidence: 1 };
      }
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
    const { data: macros } = await admin.from("macros").select("id, name, content").eq("workspace_id", wsId);
    const macro = (macros || []).find(m => m.name.toLowerCase() === pmatch.name.toLowerCase())
      || (macros || []).find(m => m.name.toLowerCase().includes(pmatch.name.toLowerCase()));
    if (macro) {
      await sysNote(admin, tid, `[System] → Macro: ${macro.name} (${conf}%)`);
      const text = await personalizeMacroText(macro.content, custCtx, msg, ch, pers);
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

  // 4. KB fallback
  const rag = await retrieveContext(wsId, msg, 3);
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
