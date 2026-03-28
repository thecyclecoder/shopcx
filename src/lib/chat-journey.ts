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

  // Find or create journey definition for this type
  const { data: journeyDef } = await ctx.admin
    .from("journey_definitions")
    .select("id, config")
    .eq("workspace_id", ctx.workspaceId)
    .eq("trigger_intent", journeyType)
    .eq("is_active", true)
    .limit(1)
    .single();

  if (!journeyDef) return false;

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
    config_snapshot: journeyDef.config,
  });

  // Get workspace branding
  const { data: ws } = await ctx.admin
    .from("workspaces")
    .select("name, help_logo_url, help_primary_color")
    .eq("id", ctx.workspaceId)
    .single();

  await sendJourneyCTA({
    workspaceId: ctx.workspaceId,
    toEmail: customer.email,
    customerName: customer.first_name || "",
    journeyToken: token,
    contextMessage,
    workspaceName: ws?.name || "Support",
    logoUrl: ws?.help_logo_url || undefined,
    primaryColor: ws?.help_primary_color || undefined,
  });

  await sendInternalNote(ctx, `[System] Sent journey CTA email to ${customer.email} for ${journeyType}`);

  // Apply step ticket status
  const status = ctx.stepTicketStatus;
  if (status && status !== "open") {
    const updates: Record<string, unknown> = { status };
    if (status === "closed") updates.resolved_at = new Date().toISOString();
    await ctx.admin.from("tickets").update(updates).eq("id", ctx.ticketId);
  }

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
    const sentCTA = await sendEmailJourneyCTA(
      ctx,
      "account_linking",
      "We noticed you might have multiple profiles. Click below to confirm which emails belong to you.",
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

    await sendChatMessage(ctx, `I'm looking into that for you! By the way, I noticed we might have multiple profiles for you in our system. Which of these emails also belong to you?<!--FORM:${formPayload}-->`);
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

    if (msgLower.includes("none of these")) {
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

  // Get all linked customer IDs
  const { data: links } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", ctx.customerId);
  let allCustomerIds = [ctx.customerId];
  if (links?.[0]?.group_id) {
    const { data: groupMembers } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", links[0].group_id);
    allCustomerIds = (groupMembers || []).map(m => m.customer_id);
  }

  // Get all profiles
  const { data: allProfiles } = await admin
    .from("customers")
    .select("id, email, phone, email_marketing_status, sms_marketing_status, shopify_customer_id, retention_score")
    .in("id", allCustomerIds);

  const profiles = allProfiles || [];
  const primaryProfile = profiles.find(p => p.id === ctx.customerId) || profiles[0];
  if (!primaryProfile) return { completed: true, waitingForForm: false };

  // Step 0: Ask consent to sign up for coupons
  if (step === 0) {
    const anyEmailSubscribed = profiles.some(p => p.email_marketing_status === "subscribed");
    const anySmsSubscribed = profiles.some(p => p.sms_marketing_status === "subscribed");

    if (anyEmailSubscribed && anySmsSubscribed) {
      // Already subscribed to both — skip to coupon
      await updateJourneyStep(ctx, 10, { emailDone: true, smsDone: true });
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
      await updateJourneyStep(ctx, 10, { emailDone: true, smsDone: true });
      return executeDiscountJourney(workspaceId, ticketId, customerMessage);
    }

    // Said yes — check email
    const anyEmailSubscribed = profiles.some(p => p.email_marketing_status === "subscribed");
    if (anyEmailSubscribed) {
      await updateJourneyStep(ctx, 5, { emailDone: true });
      return executeDiscountJourney(workspaceId, ticketId, customerMessage);
    }

    const emails = [...new Set(profiles.map(p => p.email).filter(Boolean))];
    if (emails.length <= 1) {
      const profile = profiles.find(p => p.email === emails[0] && p.shopify_customer_id);
      if (profile?.shopify_customer_id) {
        await subscribeToEmailMarketing(workspaceId, profile.shopify_customer_id);
        await sendInternalNote(ctx, `[System] Email marketing: subscribed ${emails[0]}`);
      }
      await updateJourneyStep(ctx, 5, { emailDone: true, selectedEmail: emails[0] });
      return executeDiscountJourney(workspaceId, ticketId, customerMessage);
    }

    // Multiple emails — ask
    const sentCTA = await sendEmailJourneyCTA(ctx, "discount_signup",
      "Great! Which email would you like to receive coupons at?");
    if (sentCTA) {
      await updateJourneyStep(ctx, 2);
      return { completed: false, waitingForForm: true };
    }
    const options = emails.map(e => ({ value: e, label: e }));
    const formPayload = JSON.stringify({ type: "radio", id: `email-${ticketId}`, prompt: "Which email for coupons?", options });
    await sendChatMessage(ctx, `Great! Which email would you like to receive coupons at?<!--FORM:${formPayload}-->`);
    await updateJourneyStep(ctx, 2);
    return { completed: false, waitingForForm: true };
  }

  // Step 2: Process email selection
  if (step === 2) {
    const selectedEmail = customerMessage.trim();
    const profile = profiles.find(p => p.email === selectedEmail && p.shopify_customer_id);
    if (profile?.shopify_customer_id) {
      await subscribeToEmailMarketing(workspaceId, profile.shopify_customer_id);
      await sendInternalNote(ctx, `[System] Email marketing: subscribed ${selectedEmail}`);
    }
    await updateJourneyStep(ctx, 5, { emailDone: true, selectedEmail });
    return executeDiscountJourney(workspaceId, ticketId, customerMessage);
  }

  // Step 5: Check SMS
  if (step === 5) {
    const anySmsSubscribed = profiles.some(p => p.sms_marketing_status === "subscribed");
    if (anySmsSubscribed) {
      await updateJourneyStep(ctx, 10, { smsDone: true });
      return executeDiscountJourney(workspaceId, ticketId, customerMessage);
    }

    const phones = [...new Set(profiles.map(p => p.phone).filter(Boolean))];
    if (phones.length === 0) {
      await updateJourneyStep(ctx, 10, { smsDone: true });
      return executeDiscountJourney(workspaceId, ticketId, customerMessage);
    }
    if (phones.length === 1) {
      const profile = profiles.find(p => p.phone === phones[0] && p.shopify_customer_id);
      if (profile?.shopify_customer_id) {
        await subscribeToSmsMarketing(workspaceId, profile.shopify_customer_id, phones[0]);
        await sendInternalNote(ctx, `[System] SMS marketing: subscribed ${phones[0]}`);
      }
      await updateJourneyStep(ctx, 10, { smsDone: true, selectedPhone: phones[0] });
      return executeDiscountJourney(workspaceId, ticketId, customerMessage);
    }

    // Multiple phones — ask
    const sentSMSCTA = await sendEmailJourneyCTA(ctx, "discount_signup",
      "Which phone number would you like to receive coupon notifications on?");
    if (sentSMSCTA) {
      await updateJourneyStep(ctx, 6);
      return { completed: false, waitingForForm: true };
    }
    const options = phones.map(p => ({ value: p as string, label: p as string }));
    const formPayload = JSON.stringify({ type: "radio", id: `sms-${ticketId}`, prompt: "Which phone for coupons?", options });
    await sendChatMessage(ctx, `Which phone number would you like to receive coupon notifications on?<!--FORM:${formPayload}-->`);
    await updateJourneyStep(ctx, 6);
    return { completed: false, waitingForForm: true };
  }

  // Step 6: Process SMS selection
  if (step === 6) {
    const selectedPhone = customerMessage.trim();
    const profile = profiles.find(p => p.phone === selectedPhone && p.shopify_customer_id);
    if (profile?.shopify_customer_id) {
      await subscribeToSmsMarketing(workspaceId, profile.shopify_customer_id, selectedPhone);
      await sendInternalNote(ctx, `[System] SMS marketing: subscribed ${selectedPhone}`);
    }
    await updateJourneyStep(ctx, 10, { smsDone: true, selectedPhone });
    return executeDiscountJourney(workspaceId, ticketId, customerMessage);
  }

  // Step 10: Give coupon code + check subscription
  if (step === 10) {
    // Get VIP threshold
    const { data: ws } = await admin.from("workspaces").select("vip_retention_threshold").eq("id", workspaceId).single();
    const vipThreshold = ws?.vip_retention_threshold || 85;
    const maxRetention = Math.max(...profiles.map(p => p.retention_score || 0));
    const isVip = maxRetention >= vipThreshold;

    // Get mapped coupon
    const { data: coupons } = await admin
      .from("coupon_mappings")
      .select("code, summary, customer_tier, value_type, value")
      .eq("workspace_id", workspaceId)
      .eq("ai_enabled", true);

    const eligible = (coupons || []).filter(c =>
      c.customer_tier === "all" ||
      (c.customer_tier === "vip" && isVip) ||
      (c.customer_tier === "non_vip" && !isVip)
    );

    // Prefer discount_request use case
    const coupon = eligible[0];
    const couponCode = coupon?.code || null;
    const couponSummary = coupon?.summary || "";

    if (!couponCode) {
      await sendChatMessage(ctx, "You're all signed up for our promotions! You'll be the first to know when the next coupon drops.");
      await updateJourneyStep(ctx, 99);
      return { completed: true, waitingForForm: false };
    }

    await updateJourneyStep(ctx, 11, { couponCode, isVip, couponSummary });

    // Styled coupon code block with copy button
    const codeBlock = `<div style="background:#f4f4f5;border:1px dashed #a1a1aa;border-radius:8px;padding:12px 16px;margin:8px 0;text-align:center"><span style="font-size:18px;font-weight:700;letter-spacing:2px;font-family:monospace;cursor:pointer" data-coupon="${couponCode}">${couponCode}</span><br><span style="font-size:12px;color:#71717a">${couponSummary}</span></div>`;

    // Check for active subscription with nearest renewal
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

      const sentSubCTA = await sendEmailJourneyCTA(ctx, "discount_signup",
        `Here's your coupon: ${couponCode} (${couponSummary}). You have an active subscription renewing ${nextDate} — click below to apply the coupon to it.`);
      if (sentSubCTA) {
        await updateJourneyStep(ctx, 12, { subContractId: sub.shopify_contract_id });
        return { completed: false, waitingForForm: true };
      }

      await sendChatMessage(ctx, `Here's your coupon code!\n\n${codeBlock}\n\nI also found an active subscription renewing <strong>${nextDate}</strong>:${itemsHtml}\nWould you like me to apply this coupon to your subscription?<!--FORM:${formPayload}-->`);
      await updateJourneyStep(ctx, 12, { subContractId: sub.shopify_contract_id });
      return { completed: false, waitingForForm: true };
    }

    // No subscription — just give the code
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
