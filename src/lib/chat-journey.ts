// Chat Journey Executor
// Runs deterministic step-by-step flows with interactive forms
// No AI interpretation — pure logic + forms + API calls

import { createAdminClient } from "@/lib/supabase/admin";
import { subscribeToEmailMarketing, subscribeToSmsMarketing } from "@/lib/shopify-marketing";
import { sendJourneyCTA } from "@/lib/email";
import crypto from "crypto";

type Admin = ReturnType<typeof createAdminClient>;

interface JourneyContext {
  admin: Admin;
  workspaceId: string;
  ticketId: string;
  customerId: string;
  journeyData: Record<string, unknown>;
  channel?: string;
  stepTicketStatus?: string; // 'open' | 'pending' | 'closed'
}

/**
 * For email-channel tickets, create a journey_session and send a CTA email
 * instead of embedding forms inline.
 */
async function sendEmailJourneyCTA(
  ctx: JourneyContext,
  journeyType: string,
  contextMessage?: string,
  currentForm?: { type: string; id: string; prompt: string; options?: { value: string; label: string }[] },
): Promise<boolean> {
  // CTA mini-site for channels that don't support inline forms
  // Only chat gets inline forms; all others get CTA → mini-site
  const inlineChannels = ["chat"];
  if (!ctx.channel || inlineChannels.includes(ctx.channel)) return false;

  const { data: customer } = await ctx.admin
    .from("customers")
    .select("email, first_name")
    .eq("id", ctx.customerId)
    .single();
  if (!customer?.email) return false;

  // Find journey definition
  const { data: journeyDef } = await ctx.admin
    .from("journey_definitions")
    .select("id, config")
    .eq("workspace_id", ctx.workspaceId)
    .eq("trigger_intent", journeyType)
    .eq("is_active", true)
    .limit(1)
    .single();

  if (!journeyDef) return false;

  // For code-driven journeys, embed the current form in the config
  const configForSession = (journeyDef.config as { steps?: unknown[] })?.steps?.length
    ? journeyDef.config
    : {
        codeDriven: true,
        ticketId: ctx.ticketId,
        workspaceId: ctx.workspaceId,
        message: contextMessage || "",
        currentForm: currentForm || null,
      };

  // Create session token
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await ctx.admin.from("journey_sessions").insert({
    workspace_id: ctx.workspaceId,
    journey_id: journeyDef.id,
    customer_id: ctx.customerId,
    ticket_id: ctx.ticketId,
    token,
    token_expires_at: expiresAt,
    status: "pending",
    config_snapshot: configForSession,
  });

  // Get workspace branding
  const { data: ws } = await ctx.admin
    .from("workspaces")
    .select("name, help_logo_url, help_primary_color")
    .eq("id", ctx.workspaceId)
    .single();

  const wsName = ws?.name || "Support";

  // Get ticket subject + last message ID for email threading
  const { data: ticketData } = await ctx.admin
    .from("tickets")
    .select("subject, email_message_id")
    .eq("id", ctx.ticketId)
    .single();

  // Get the original email Message-ID for threading (In-Reply-To header)
  // Try ticket-level first (original inbound), then last message with an email_message_id
  let inReplyToId: string | null = ticketData?.email_message_id || null;
  if (!inReplyToId) {
    const { data: lastMsg } = await ctx.admin
      .from("ticket_messages")
      .select("email_message_id")
      .eq("ticket_id", ctx.ticketId)
      .not("email_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    inReplyToId = lastMsg?.email_message_id || null;
  }

  const ticketSubject = ticketData?.subject || "Your request";

  await sendJourneyCTA({
    workspaceId: ctx.workspaceId,
    toEmail: customer.email,
    customerName: customer.first_name || "",
    journeyToken: token,
    contextMessage,
    workspaceName: wsName,
    primaryColor: ws?.help_primary_color || undefined,
    subject: `Re: ${ticketSubject}`,
    buttonLabel: currentForm?.type === "checklist" ? "Select your emails &rarr;" : currentForm?.type === "confirm" ? "Respond &rarr;" : "Continue &rarr;",
    inReplyTo: inReplyToId,
  });

  await sendInternalNote(ctx, `[System] Sent journey CTA email to ${customer.email} for ${journeyType}`);

  // Apply step ticket status
  const status = ctx.stepTicketStatus;
  if (status && status !== "open") {
    const updates: Record<string, unknown> = { status };
    if (status === "closed") updates.resolved_at = new Date().toISOString();
    await ctx.admin.from("tickets").update(updates).eq("id", ctx.ticketId);
  }

  // Mark first touch
  const { markFirstTouch } = await import("@/lib/first-touch");
  await markFirstTouch(ctx.ticketId, "journey");

  return true;
}

// Send a message in the chat (external, visible in widget)
// Also sets ticket status per the journey's step_ticket_status setting
async function sendChatMessage(ctx: JourneyContext, body: string) {
  await ctx.admin.from("ticket_messages").insert({
    ticket_id: ctx.ticketId,
    direction: "outbound",
    visibility: "external",
    author_type: "system",
    body,
  });

  const status = ctx.stepTicketStatus;
  if (status && status !== "open") {
    const updates: Record<string, unknown> = { status };
    if (status === "closed") updates.resolved_at = new Date().toISOString();
    await ctx.admin.from("tickets").update(updates).eq("id", ctx.ticketId);
  }

  // Mark first touch
  const { markFirstTouch } = await import("@/lib/first-touch");
  await markFirstTouch(ctx.ticketId, "journey");
}

// Send an internal note
async function sendInternalNote(ctx: JourneyContext, body: string) {
  await ctx.admin.from("ticket_messages").insert({
    ticket_id: ctx.ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body,
  });
}

// Update journey progress on ticket
async function updateJourneyStep(ctx: JourneyContext, step: number, data?: Record<string, unknown>) {
  const updates: Record<string, unknown> = { journey_step: step };
  if (data) updates.journey_data = { ...ctx.journeyData, ...data };
  await ctx.admin.from("tickets").update(updates).eq("id", ctx.ticketId);
  if (data) Object.assign(ctx.journeyData, data);
}

// Load step_ticket_status for a journey by trigger_intent
async function getStepTicketStatus(admin: Admin, workspaceId: string, triggerIntent: string): Promise<string> {
  const { data } = await admin
    .from("journey_definitions")
    .select("step_ticket_status")
    .eq("workspace_id", workspaceId)
    .eq("trigger_intent", triggerIntent)
    .limit(1)
    .single();
  return (data?.step_ticket_status as string) || "open";
}

// ============================================================
// JOURNEY: Account Linking
// ============================================================
export async function executeAccountLinkingJourney(
  workspaceId: string,
  ticketId: string,
  customerMessage: string,
  channel?: string,
): Promise<{ completed: boolean; linkedIds: string[] }> {
  const admin = createAdminClient();

  const { data: ticket } = await admin
    .from("tickets")
    .select("customer_id, journey_step, journey_data, channel")
    .eq("id", ticketId)
    .single();

  if (!ticket?.customer_id) return { completed: true, linkedIds: [] };

  const stepTicketStatus = await getStepTicketStatus(admin, workspaceId, "account_linking");
  const ctx: JourneyContext = {
    admin, workspaceId, ticketId,
    customerId: ticket.customer_id,
    journeyData: (ticket.journey_data as Record<string, unknown>) || {},
    channel: channel || ticket.channel,
    stepTicketStatus,
  };

  const step = ticket.journey_step || 0;

  // Step 0: Initial — find unlinked matches and send form
  if (step === 0) {
    const { data: cust } = await admin
      .from("customers")
      .select("id, email, first_name, last_name")
      .eq("id", ctx.customerId)
      .single();

    if (!cust?.first_name || !cust?.last_name) return { completed: true, linkedIds: [] };

    // Get existing link group
    const { data: existingLinks } = await admin
      .from("customer_links")
      .select("group_id")
      .eq("customer_id", cust.id);
    const groupId = existingLinks?.[0]?.group_id || null;

    let alreadyLinkedIds: string[] = [];
    if (groupId) {
      const { data: groupMembers } = await admin
        .from("customer_links")
        .select("customer_id")
        .eq("group_id", groupId);
      alreadyLinkedIds = (groupMembers || []).map(m => m.customer_id);
    }

    // Get rejected
    const { data: rejections } = await admin
      .from("customer_link_rejections")
      .select("rejected_customer_id")
      .eq("customer_id", cust.id);
    const rejectedIds = (rejections || []).map(r => r.rejected_customer_id);

    // Find unlinked name matches
    const { data: matches } = await admin
      .from("customers")
      .select("id, email")
      .eq("workspace_id", workspaceId)
      .eq("first_name", cust.first_name)
      .eq("last_name", cust.last_name)
      .neq("id", cust.id)
      .neq("email", cust.email)
      .limit(5);

    const unlinked = (matches || []).filter(m => !alreadyLinkedIds.includes(m.id) && !rejectedIds.includes(m.id));

    if (unlinked.length === 0) return { completed: true, linkedIds: alreadyLinkedIds };

    // For non-inline channels, send CTA email instead
    const linkForm = {
      type: "checklist",
      id: `link-${ticketId}`,
      prompt: "Select all emails that belong to you",
      options: unlinked.map(m => ({ value: m.id, label: m.email })),
    };
    const sentCTA = await sendEmailJourneyCTA(
      ctx,
      "account_linking",
      "I got your message and I'm going to help you. I noticed you might have multiple profiles in our system. Can you tell me which ones are yours?",
      linkForm,
    );
    if (sentCTA) {
      await updateJourneyStep(ctx, 1, { unlinkedMatches: unlinked, existingGroupId: groupId });
      return { completed: false, linkedIds: [] };
    }

    // Send checklist form (inline for chat/help_center)
    const options = unlinked.map(m => ({ value: m.id, label: m.email }));
    const formPayload = JSON.stringify({
      type: "checklist",
      id: `link-${ticketId}`,
      prompt: "Select emails that belong to you",
      options,
    });

    await sendChatMessage(ctx, `I got your message and I'm going to help you. I noticed you might have multiple profiles in our system. Can you tell me which ones are yours?<!--FORM:${formPayload}-->`);
    await updateJourneyStep(ctx, 1, { unlinkedMatches: unlinked, existingGroupId: groupId });
    return { completed: false, linkedIds: [] };
  }

  // Step 1: Process linking response
  if (step === 1) {
    const unlinked = (ctx.journeyData.unlinkedMatches as { id: string; email: string }[]) || [];
    const groupId = (ctx.journeyData.existingGroupId as string) || null;
    const msgLower = customerMessage.toLowerCase();

    // Parse which were confirmed
    const confirmed: string[] = [];
    const rejected: string[] = [];

    if (msgLower.includes("none of these") || msgLower === "no") {
      // All rejected
      for (const m of unlinked) rejected.push(m.id);
    } else if (msgLower.includes("these are mine") || msgLower.includes("yes")) {
      // Parse confirmed emails from message
      for (const m of unlinked) {
        if (customerMessage.includes(m.email)) confirmed.push(m.id);
        else rejected.push(m.id);
      }
    } else if (msgLower.includes("skip")) {
      // Skip = don't link, don't reject
      await updateJourneyStep(ctx, 99);
      return { completed: true, linkedIds: [] };
    } else {
      // Mini-site sends customer IDs (UUIDs) or comma-separated values
      // Match by ID or email in the response
      for (const m of unlinked) {
        if (customerMessage.includes(m.id) || customerMessage.includes(m.email)) {
          confirmed.push(m.id);
        } else {
          rejected.push(m.id);
        }
      }
    }

    // Link confirmed
    if (confirmed.length > 0) {
      const linkGroupId = groupId || crypto.randomUUID();

      // Ensure primary exists
      if (!groupId) {
        await admin.from("customer_links").upsert({
          customer_id: ctx.customerId,
          workspace_id: workspaceId,
          group_id: linkGroupId,
          is_primary: true,
        }, { onConflict: "customer_id" });
      }

      for (const id of confirmed) {
        await admin.from("customer_links").upsert({
          customer_id: id,
          workspace_id: workspaceId,
          group_id: linkGroupId,
          is_primary: false,
        }, { onConflict: "customer_id" });
      }

      await sendInternalNote(ctx, `[System] Account linking: ${confirmed.length} profiles linked`);
    }

    // Reject rejected
    for (const id of rejected) {
      await admin.from("customer_link_rejections").upsert({
        workspace_id: workspaceId,
        customer_id: ctx.customerId,
        rejected_customer_id: id,
      }, { onConflict: "customer_id,rejected_customer_id" });
    }

    await updateJourneyStep(ctx, 99);

    // Get all linked IDs for the next journey
    const { data: allLinks } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", groupId || "");
    const linkedIds = (allLinks || []).map(l => l.customer_id);

    return { completed: true, linkedIds };
  }

  return { completed: true, linkedIds: [] };
}

// ============================================================
// JOURNEY: Discount / Marketing Signup
// ============================================================
export async function executeDiscountJourney(
  workspaceId: string,
  ticketId: string,
  customerMessage: string,
  channel?: string,
): Promise<{ completed: boolean; waitingForForm: boolean }> {
  const admin = createAdminClient();

  const { data: ticket } = await admin
    .from("tickets")
    .select("customer_id, journey_step, journey_data, channel")
    .eq("id", ticketId)
    .single();

  if (!ticket?.customer_id) return { completed: true, waitingForForm: false };

  const stepTicketStatus = await getStepTicketStatus(admin, workspaceId, "discount_signup");
  const ctx: JourneyContext = {
    admin, workspaceId, ticketId,
    customerId: ticket.customer_id,
    journeyData: (ticket.journey_data as Record<string, unknown>) || {},
    channel: channel || ticket.channel,
    stepTicketStatus,
  };

  const step = ticket.journey_step || 0;

  // Main customer only — no linked account considerations for marketing
  const { data: customer } = await admin
    .from("customers")
    .select("id, email, phone, email_marketing_status, sms_marketing_status, shopify_customer_id, retention_score")
    .eq("id", ctx.customerId)
    .single();

  if (!customer) return { completed: true, waitingForForm: false };

  // Step 0: Ask consent (skip if already subscribed to both)
  if (step === 0) {
    if (customer.email_marketing_status === "subscribed" && customer.sms_marketing_status === "subscribed") {
      await updateJourneyStep(ctx, 10);
      return executeDiscountJourney(workspaceId, ticketId, customerMessage);
    }

    const formPayload = JSON.stringify({ type: "confirm", id: `signup-consent-${ticketId}`, prompt: "Sign up for coupons?" });
    await sendChatMessage(ctx, `We have exclusive coupons for our email and SMS subscribers! Would you like to sign up to get the latest deals delivered to you?<!--FORM:${formPayload}-->`);
    await updateJourneyStep(ctx, 1);
    return { completed: false, waitingForForm: true };
  }

  // Step 1: Process consent
  if (step === 1) {
    const msgLower = customerMessage.toLowerCase().trim();
    if (msgLower === "no" || msgLower.includes("no thanks")) {
      await updateJourneyStep(ctx, 10);
      return executeDiscountJourney(workspaceId, ticketId, customerMessage);
    }

    // Subscribe email (main customer's email, always)
    if (customer.shopify_customer_id && customer.email_marketing_status !== "subscribed") {
      await subscribeToEmailMarketing(workspaceId, customer.shopify_customer_id);
      await admin.from("customers").update({ email_marketing_status: "subscribed" }).eq("id", customer.id);
      await sendInternalNote(ctx, `[System] Email marketing: subscribed ${customer.email}`);
    }

    // Check if phone is on file
    if (customer.sms_marketing_status !== "subscribed") {
      if (customer.phone) {
        // Has phone — subscribe directly
        if (customer.shopify_customer_id) {
          await subscribeToSmsMarketing(workspaceId, customer.shopify_customer_id, customer.phone);
          await admin.from("customers").update({ sms_marketing_status: "subscribed" }).eq("id", customer.id);
          await sendInternalNote(ctx, `[System] SMS marketing: subscribed ${customer.phone}`);
        }
      } else {
        // No phone — ask for it
        const formPayload = JSON.stringify({ type: "text_input", id: `phone-input-${ticketId}`, prompt: "What's your phone number?", placeholder: "+1 (555) 123-4567" });
        await sendChatMessage(ctx, `Great, you're signed up for email coupons! What's your phone number so we can text you deals too?<!--FORM:${formPayload}-->`);
        await updateJourneyStep(ctx, 2);
        return { completed: false, waitingForForm: true };
      }
    }

    // All done with marketing — go to coupon
    await updateJourneyStep(ctx, 10);
    return executeDiscountJourney(workspaceId, ticketId, customerMessage);
  }

  // Step 2: Process phone input
  if (step === 2) {
    const rawPhone = customerMessage.trim().replace(/[\s\-\(\)\.]/g, "");
    const phone = rawPhone && !rawPhone.startsWith("+") ? `+1${rawPhone.replace(/^1/, "")}` : rawPhone;
    if (phone && customer.shopify_customer_id) {
      await admin.from("customers").update({ phone }).eq("id", customer.id);
      await subscribeToSmsMarketing(workspaceId, customer.shopify_customer_id, phone);
      await admin.from("customers").update({ sms_marketing_status: "subscribed" }).eq("id", customer.id);
      await sendInternalNote(ctx, `[System] SMS marketing: subscribed ${phone}`);
    }
    await updateJourneyStep(ctx, 10);
    return executeDiscountJourney(workspaceId, ticketId, customerMessage);
  }

  // Step 10: Give coupon code + check subscription
  if (step === 10) {
    const { data: ws } = await admin.from("workspaces").select("vip_retention_threshold").eq("id", workspaceId).single();
    const vipThreshold = ws?.vip_retention_threshold || 85;
    const isVip = (customer.retention_score || 0) >= vipThreshold;

    const { data: coupons } = await admin
      .from("coupon_mappings")
      .select("code, summary, customer_tier")
      .eq("workspace_id", workspaceId)
      .eq("ai_enabled", true);

    const eligible = (coupons || []).filter(c =>
      c.customer_tier === "all" ||
      (c.customer_tier === "vip" && isVip) ||
      (c.customer_tier === "non_vip" && !isVip)
    );

    const coupon = eligible[0];
    const couponCode = coupon?.code || null;
    const couponSummary = coupon?.summary || "";

    if (!couponCode) {
      await sendChatMessage(ctx, "You're all signed up for our promotions! You'll be the first to know when the next coupon drops.");
      await updateJourneyStep(ctx, 99);
      return { completed: true, waitingForForm: false };
    }

    await updateJourneyStep(ctx, 11, { couponCode, couponSummary });

    const codeBlock = `<div style="background:#f4f4f5;border:1px dashed #a1a1aa;border-radius:8px;padding:12px 16px;margin:8px 0;text-align:center"><span style="font-size:18px;font-weight:700;letter-spacing:2px;font-family:monospace;cursor:pointer" data-coupon="${couponCode}">${couponCode}</span><br><span style="font-size:12px;color:#71717a">${couponSummary}</span></div>`;

    // Check for active subscription (use linked IDs for sub lookup)
    let allCustomerIds = [ctx.customerId];
    const { data: links } = await admin.from("customer_links").select("group_id").eq("customer_id", ctx.customerId);
    if (links?.[0]?.group_id) {
      const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", links[0].group_id);
      allCustomerIds = (grp || []).map(m => m.customer_id);
    }

    const { data: activeSubs } = await admin
      .from("subscriptions")
      .select("id, shopify_contract_id, next_billing_date, items")
      .in("customer_id", allCustomerIds)
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("next_billing_date", { ascending: true })
      .limit(1);

    if (activeSubs?.length && activeSubs[0].shopify_contract_id) {
      const sub = activeSubs[0];
      const nextDate = sub.next_billing_date ? new Date(sub.next_billing_date).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : "soon";
      const itemsList = (sub.items as { title: string }[] | null) || [];
      const itemsHtml = itemsList.length > 0
        ? `<ul style="margin:8px 0 12px;padding-left:20px">${itemsList.map(i => `<li style="margin:2px 0">${i.title}</li>`).join("")}</ul>`
        : "";

      const formPayload = JSON.stringify({ type: "confirm", id: `coupon-apply-${ticketId}`, prompt: "Apply coupon to subscription?" });
      await sendChatMessage(ctx, `Here's your coupon code!\n\n${codeBlock}\n\nI also found an active subscription renewing <strong>${nextDate}</strong>:${itemsHtml}\nWould you like me to apply this coupon to your subscription?<!--FORM:${formPayload}-->`);
      await updateJourneyStep(ctx, 12, { subContractId: sub.shopify_contract_id });
      return { completed: false, waitingForForm: true };
    }

    await sendChatMessage(ctx, `Here's your coupon code!\n\n${codeBlock}\n\nUse it at checkout whenever you're ready.`);
    await updateJourneyStep(ctx, 99);
    return { completed: true, waitingForForm: false };
  }

  // Step 12: Process subscription coupon choice
  if (step === 12) {
    const msgLower = customerMessage.toLowerCase();
    const couponCode = ctx.journeyData.couponCode as string;
    const subContractId = ctx.journeyData.subContractId as string;

    if (msgLower === "yes" || msgLower.includes("apply") || msgLower.includes("subscription")) {
      // Apply coupon to subscription via Appstle
      try {
        const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", workspaceId).single();
        if (ws?.appstle_api_key_encrypted) {
          const { decrypt } = await import("@/lib/crypto");
          const apiKey = decrypt(ws.appstle_api_key_encrypted);

          // Remove existing discounts first
          const rawRes = await fetch(
            `https://subscription-admin.appstle.com/api/external/v2/contract-raw-response?contractId=${subContractId}&api_key=${apiKey}`,
            { headers: { "X-API-Key": apiKey } }
          );
          if (rawRes.ok) {
            const rawText = await rawRes.text();
            const nodesMatch = rawText.match(/"discounts"[\s\S]*?"nodes"\s*:\s*\[([\s\S]*?)\]/);
            if (nodesMatch && nodesMatch[1].trim()) {
              try {
                const nodes = JSON.parse(`[${nodesMatch[1]}]`);
                for (const node of nodes) {
                  if (node.id) {
                    await fetch(
                      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-discount?contractId=${subContractId}&discountId=${encodeURIComponent(node.id)}&api_key=${apiKey}`,
                      { method: "PUT", headers: { "X-API-Key": apiKey } }
                    );
                  }
                }
              } catch {}
            }
          }

          // Apply new coupon
          await fetch(
            `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-apply-discount?contractId=${subContractId}&discountCode=${couponCode}&api_key=${apiKey}`,
            { method: "PUT", headers: { "X-API-Key": apiKey } }
          );

          await sendChatMessage(ctx, `Done! I've applied ${couponCode} to your subscription. You'll see the discount on your next renewal.`);
          await sendInternalNote(ctx, `[System] Coupon ${couponCode} applied to subscription ${subContractId}`);
        }
      } catch (err) {
        await sendChatMessage(ctx, `I tried to apply the coupon but ran into an issue. You can still use code ${couponCode} at checkout!`);
        await sendInternalNote(ctx, `[System] Failed to apply coupon to subscription: ${err}`);
      }
    } else {
      const couponSummary = (ctx.journeyData.couponSummary as string) || "";
      const codeBlock = `<div style="background:#f4f4f5;border:1px dashed #a1a1aa;border-radius:8px;padding:12px 16px;margin:8px 0;text-align:center"><span style="font-size:18px;font-weight:700;letter-spacing:2px;font-family:monospace;cursor:pointer" data-coupon="${couponCode}">${couponCode}</span><br><span style="font-size:12px;color:#71717a">${couponSummary}</span></div>`;
      await sendChatMessage(ctx, `No problem! Just use your code at checkout whenever you're ready.\n\n${codeBlock}`);
    }

    await updateJourneyStep(ctx, 99);
    return { completed: true, waitingForForm: false };
  }

  // Done
  return { completed: true, waitingForForm: false };
}
