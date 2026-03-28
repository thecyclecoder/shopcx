import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { subscribeToEmailMarketing, subscribeToSmsMarketing } from "@/lib/shopify-marketing";

// POST: Complete a journey session
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, ticket_id, customer_id, status, config_snapshot")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (session.status === "completed") {
    return NextResponse.json({ success: true, message: "Already completed" });
  }

  const body = await request.json();
  const { outcome, responses } = body as {
    outcome: string;
    responses?: Record<string, { value: string; label: string }>;
  };

  if (!outcome) return NextResponse.json({ error: "outcome required" }, { status: 400 });

  const config = session.config_snapshot as Record<string, unknown> || {};

  // Process multi-step discount journey responses
  if (config.multiStep && responses && outcome !== "declined") {
    const metadata = (config.metadata || {}) as Record<string, unknown>;
    const allCustomerIds = (metadata.allCustomerIds as string[]) || [];
    const wsId = session.workspace_id;

    const actionLog: string[] = [];

    // Process account linking (if part of combined journey)
    const linkResponse = responses.account_linking;
    if (linkResponse && metadata.linkCustomerId) {
      const linkCustId = metadata.linkCustomerId as string;
      const unlinked = (metadata.unlinkedMatches as { id: string; email: string }[]) || [];
      const existingGroupId = (metadata.existingGroupId as string) || null;

      // Parse confirmed (checklist sends comma-separated IDs)
      const confirmedIds = linkResponse.value.split(",").map((v: string) => v.trim()).filter(Boolean);
      const confirmedSet = new Set(confirmedIds);

      if (confirmedIds.length > 0) {
        const { randomUUID } = await import("crypto");
        const groupId = existingGroupId || randomUUID();

        if (!existingGroupId) {
          await admin.from("customer_links").upsert({
            customer_id: linkCustId, workspace_id: wsId, group_id: groupId, is_primary: true,
          }, { onConflict: "customer_id" });
        }
        for (const id of confirmedIds) {
          await admin.from("customer_links").upsert({
            customer_id: id, workspace_id: wsId, group_id: groupId, is_primary: false,
          }, { onConflict: "customer_id" });
        }
        actionLog.push(`Account linking: ${confirmedIds.length} profiles linked`);

        // Expand allCustomerIds to include newly linked
        for (const id of confirmedIds) {
          if (!allCustomerIds.includes(id)) allCustomerIds.push(id);
        }
      }

      // Reject non-confirmed
      for (const m of unlinked) {
        if (!confirmedSet.has(m.id)) {
          await admin.from("customer_link_rejections").upsert({
            workspace_id: wsId, customer_id: linkCustId, rejected_customer_id: m.id,
          }, { onConflict: "customer_id,rejected_customer_id" });
        }
      }

      await admin.from("tickets").update({ profile_link_completed: true }).eq("id", session.ticket_id);
    }

    // Get the main customer profile for marketing subscription
    const mainCustomerId = (metadata.customerId as string) || allCustomerIds[0];
    const shopifyCustomerId = metadata.shopifyCustomerId as string;
    const customerEmail = metadata.customerEmail as string;

    // Process consent — subscribe main customer's email + phone
    const consent = responses.consent;
    if (consent?.value === "Yes" && shopifyCustomerId) {
      // Subscribe email (always the main customer's email)
      await subscribeToEmailMarketing(wsId, shopifyCustomerId);
      await admin.from("customers").update({ email_marketing_status: "subscribed" }).eq("id", mainCustomerId);
      actionLog.push(`Email marketing: subscribed ${customerEmail}`);

      // Subscribe SMS — use phone from input or existing phone on file
      const phoneInput = responses.phone_input?.value?.trim();
      const existingPhone = metadata.customerPhone as string | undefined;
      const phone = phoneInput || existingPhone;

      if (phone) {
        // If phone was entered, save it to the customer record first
        if (phoneInput && !existingPhone) {
          await admin.from("customers").update({ phone: phoneInput }).eq("id", mainCustomerId);
        }
        await subscribeToSmsMarketing(wsId, shopifyCustomerId, phone);
        await admin.from("customers").update({ sms_marketing_status: "subscribed" }).eq("id", mainCustomerId);
        actionLog.push(`SMS marketing: subscribed ${phone}`);
      }
    }

    // Apply coupon to subscription
    const subChoice = responses.apply_subscription;
    const couponCode = metadata.couponCode as string;
    const subContractId = metadata.subContractId as string;

    if (subChoice?.value === "Yes" && couponCode && subContractId) {
      try {
        const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", wsId).single();
        if (ws?.appstle_api_key_encrypted) {
          const { decrypt } = await import("@/lib/crypto");
          const apiKey = decrypt(ws.appstle_api_key_encrypted);

          // Remove existing discounts
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
          actionLog.push(`Coupon ${couponCode} applied to subscription ${subContractId}`);
        }
      } catch (err) {
        actionLog.push(`Failed to apply coupon: ${err}`);
      }
    }

    // Log actions to ticket
    if (session.ticket_id && actionLog.length > 0) {
      await admin.from("ticket_messages").insert({
        ticket_id: session.ticket_id,
        direction: "outbound",
        visibility: "internal",
        author_type: "system",
        body: `[System] Discount journey completed:\n${actionLog.map(a => `• ${a}`).join("\n")}`,
      });
    }

    // Build human-readable summary + send as email reply
    const couponSummary = metadata.couponSummary as string || "";
    if (couponCode && session.ticket_id) {
      const summaryParts: string[] = [];
      if (consent?.value === "Yes") summaryParts.push("signed up for email and SMS promotions");
      if (subChoice?.value === "Yes") summaryParts.push(`applied ${couponCode} to subscription`);
      const summaryText = summaryParts.length > 0 ? `We've ${summaryParts.join(" and ")}.` : "";

      const replyBody = `<p>${summaryText} Your coupon code is <strong>${couponCode}</strong> (${couponSummary}). Use it at checkout anytime!</p>`;

      await admin.from("ticket_messages").insert({
        ticket_id: session.ticket_id,
        direction: "outbound",
        visibility: "external",
        author_type: "system",
        body: replyBody,
      });

      // Send as actual email reply
      const { data: ticketData } = await admin.from("tickets")
        .select("subject, email_message_id, channel, customer_id")
        .eq("id", session.ticket_id)
        .single();

      if (ticketData?.channel === "email" && ticketData.customer_id) {
        const { data: cust } = await admin.from("customers").select("email").eq("id", ticketData.customer_id).single();
        const { data: ws } = await admin.from("workspaces").select("name").eq("id", wsId).single();

        if (cust?.email) {
          const { sendTicketReply } = await import("@/lib/email");
          await sendTicketReply({
            workspaceId: wsId,
            toEmail: cust.email,
            subject: ticketData.subject ? `Re: ${ticketData.subject}` : "Re: Your request",
            body: replyBody,
            inReplyTo: ticketData.email_message_id || null,
            agentName: "Support",
            workspaceName: ws?.name || "Support",
          });
        }
      }
    }

    // Close the ticket
    if (session.ticket_id) {
      await admin.from("tickets").update({
        status: "closed",
        resolved_at: new Date().toISOString(),
        journey_step: 99,
      }).eq("id", session.ticket_id);
    }
  }

  // Mark session completed
  await admin
    .from("journey_sessions")
    .update({
      status: "completed",
      outcome,
      responses: responses || {},
      completed_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  // Fire Inngest event for outcome processing (for cancellation journeys)
  if (!config.multiStep) {
    await inngest.send({
      name: "journey/session.completed",
      data: { session_id: session.id, outcome, workspace_id: session.workspace_id },
    });
  }

  // Determine thank-you message
  let message: string;
  if (outcome === "declined") {
    message = "No problem! You can always sign up later.";
  } else if (config.multiStep) {
    const couponCode = (config.metadata as Record<string, unknown>)?.couponCode;
    message = couponCode
      ? `You're all set! Your coupon code is ${couponCode}. Check your email for confirmation.`
      : "You're all set! Check your email for the latest deals.";
  } else if (outcome === "cancelled") {
    const messages = (config.messages as Record<string, string>) || {};
    message = messages.completedCancel || "Your subscription has been cancelled.";
  } else if (outcome?.startsWith("saved_")) {
    const messages = (config.messages as Record<string, string>) || {};
    message = messages.completedSave || "Great news! We've updated your subscription.";
  } else {
    message = "Thank you! We've processed your request.";
  }

  return NextResponse.json({ success: true, message });
}
