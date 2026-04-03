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
    .select("id, workspace_id, ticket_id, customer_id, journey_id, status, config_snapshot")
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
  const journeyType = config.journeyType as string || null;

  // ── Code-driven journey completion (step-builder based) ──
  if (config.codeDriven && journeyType) {
    const wsId = session.workspace_id;
    const actionLog: string[] = [];
    const metadata = (config.metadata || {}) as Record<string, unknown>;

    if (journeyType === "account_linking") {
      const unlinked = (metadata.unlinkedMatches as { id: string; email: string }[]) || [];
      const existingGroupId = (metadata.existingGroupId as string) || null;
      const linkResponse = responses?.link_accounts;
      const confirmResponse = responses?.confirm_link;

      if (confirmResponse?.value === "yes" && linkResponse?.value) {
        const confirmedIds = linkResponse.value.split(",").map((v: string) => v.trim()).filter(Boolean);
        const confirmedSet = new Set(confirmedIds);

        if (confirmedIds.length > 0) {
          const { randomUUID } = await import("crypto");
          const groupId = existingGroupId || randomUUID();

          // Link the primary customer if not already linked
          if (!existingGroupId) {
            await admin.from("customer_links").upsert({
              customer_id: session.customer_id, workspace_id: wsId, group_id: groupId, is_primary: true,
            }, { onConflict: "customer_id" });
          }
          // Link confirmed accounts
          for (const id of confirmedIds) {
            await admin.from("customer_links").upsert({
              customer_id: id, workspace_id: wsId, group_id: groupId, is_primary: false,
            }, { onConflict: "customer_id" });
          }
          const linkedEmails = unlinked.filter(m => confirmedSet.has(m.id)).map(m => m.email);
          actionLog.push(`Linked accounts: ${linkedEmails.join(", ")}`);

          if (session.ticket_id) {
            const { addTicketTag } = await import("@/lib/ticket-tags");
            await addTicketTag(session.ticket_id, "link");
          }
        }

        // Reject non-confirmed
        for (const m of unlinked) {
          if (!confirmedSet.has(m.id)) {
            await admin.from("customer_link_rejections").upsert({
              workspace_id: wsId, customer_id: session.customer_id, rejected_customer_id: m.id,
            }, { onConflict: "customer_id,rejected_customer_id" });
            actionLog.push(`Rejected account: ${m.email}`);
          }
        }
      } else if (confirmResponse?.value === "no" || outcome === "declined") {
        // Reject all
        for (const m of unlinked) {
          await admin.from("customer_link_rejections").upsert({
            workspace_id: wsId, customer_id: session.customer_id, rejected_customer_id: m.id,
          }, { onConflict: "customer_id,rejected_customer_id" });
        }
        actionLog.push(`Rejected all ${unlinked.length} suggested accounts`);
      }
    }

    if (journeyType === "discount_signup" || journeyType === "marketing_signup") {
      const consentResponse = responses?.consent;
      if (consentResponse?.value === "yes") {
        const { data: customer } = await admin.from("customers")
          .select("shopify_customer_id, phone").eq("id", session.customer_id).single();

        if (customer?.shopify_customer_id) {
          await subscribeToEmailMarketing(wsId, customer.shopify_customer_id);
          await admin.from("customers").update({ email_marketing_status: "subscribed" }).eq("id", session.customer_id);
          actionLog.push("Email marketing: subscribed");

          const phoneInput = responses?.phone?.value?.trim().replace(/[\s\-\(\)\.]/g, "") || "";
          const phone = phoneInput ? (phoneInput.startsWith("+") ? phoneInput : `+1${phoneInput.replace(/^1/, "")}`) : customer.phone;
          if (phone) {
            if (phoneInput && !customer.phone) {
              await admin.from("customers").update({ phone }).eq("id", session.customer_id);
            }
            await subscribeToSmsMarketing(wsId, customer.shopify_customer_id, phone);
            await admin.from("customers").update({ sms_marketing_status: "subscribed" }).eq("id", session.customer_id);
            actionLog.push(`SMS marketing: subscribed (${phone})`);
          }
        }
      } else {
        actionLog.push("Customer declined marketing signup");
      }
    }

    // Post internal note with all actions
    if (session.ticket_id && actionLog.length > 0) {
      await admin.from("ticket_messages").insert({
        ticket_id: session.ticket_id,
        direction: "outbound",
        visibility: "internal",
        author_type: "system",
        body: `[System] Journey "${journeyType}" completed:\n${actionLog.map(a => `• ${a}`).join("\n")}`,
      });
    }

    // Update journey_history on ticket
    if (session.ticket_id) {
      const { data: ticketData } = await admin.from("tickets").select("journey_history").eq("id", session.ticket_id).single();
      const history = (ticketData?.journey_history as { journey_id: string; completed: boolean }[]) || [];
      const entry = history.find(h => h.journey_id === session.journey_id);
      if (entry) entry.completed = true;
      await admin.from("tickets").update({ journey_history: history }).eq("id", session.ticket_id);

      const { addTicketTag } = await import("@/lib/ticket-tags");
      await addTicketTag(session.ticket_id, outcome === "declined" ? "jo:negative" : "jo:positive");
    }

    // Mark session completed
    await admin.from("journey_sessions").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      outcome,
      responses,
    }).eq("id", session.id);

    // Re-trigger unified handler with the ORIGINAL customer message
    if (session.ticket_id && journeyType === "account_linking" && outcome !== "declined") {
      // Find the first inbound customer message on this ticket
      const { data: originalMsg } = await admin.from("ticket_messages")
        .select("body")
        .eq("ticket_id", session.ticket_id)
        .eq("direction", "inbound")
        .eq("author_type", "customer")
        .order("created_at", { ascending: true })
        .limit(1).single();

      const { data: ticketInfo } = await admin.from("tickets")
        .select("channel").eq("id", session.ticket_id).single();

      await admin.from("ticket_messages").insert({
        ticket_id: session.ticket_id, direction: "outbound", visibility: "internal",
        author_type: "system", body: "[System] Account linking completed. Re-processing original request with enriched context.",
      });

      await inngest.send({
        name: "ticket/inbound-message",
        data: {
          workspace_id: wsId,
          ticket_id: session.ticket_id,
          message_body: originalMsg?.body || "",
          channel: ticketInfo?.channel || "email",
          is_new_ticket: false,
        },
      });
    }

    return NextResponse.json({ success: true, message: actionLog.length > 0 ? "All done! We've updated your account." : "Thanks for letting us know!" });
  }

  // Process cancel journey completion
  if (config.cancelJourney) {
    const metadata = (config.metadata || {}) as Record<string, unknown>;
    const wsId = session.workspace_id;
    const actionLog: string[] = [];

    const cancelReason = responses?.cancel_reason?.value || "unknown";
    const cancelReasonLabel = responses?.cancel_reason?.label || cancelReason;

    // Determine which subscription to act on
    const subscriptions = (metadata.subscriptions as { id: string; contractId: string; items: { title: string }[]; isFirstRenewal?: boolean }[]) || [];
    const selectedSubId = responses?.select_subscription?.value || (metadata.selectedSubscriptionId as string);
    const selectedSub = subscriptions.find(s => s.id === selectedSubId) || subscriptions[0];
    const isFirstRenewal = selectedSub?.isFirstRenewal || false;

    if (outcome === "cancelled" && selectedSub) {
      // Cancel via Appstle API
      const { appstleSubscriptionAction } = await import("@/lib/appstle");
      const result = await appstleSubscriptionAction(
        wsId,
        selectedSub.contractId,
        "cancel",
        `customer_request: ${cancelReasonLabel}`,
        "Customer via cancel journey",
      );

      if (result.success) {
        actionLog.push(`Cancelled subscription ${selectedSub.contractId} (${selectedSub.items.map(i => i.title).join(", ")})`);
      } else {
        actionLog.push(`Failed to cancel subscription: ${result.error}`);
      }

      // Record remedy outcome (cancelled = no remedy accepted)
      if (session.customer_id) {
        // Get LTV + sub age for analytics
        const { data: custOrders } = await admin.from("orders").select("total_price_cents").eq("customer_id", session.customer_id);
        const customerLtv = custOrders?.reduce((s, o) => s + (o.total_price_cents || 0), 0) || 0;
        const { data: subData } = selectedSub ? await admin.from("subscriptions").select("id, created_at").eq("shopify_contract_id", selectedSub.contractId).eq("workspace_id", wsId).maybeSingle() : { data: null };
        const subAgeDays = subData?.created_at ? Math.floor((Date.now() - new Date(subData.created_at).getTime()) / 86400000) : 0;

        await admin.from("remedy_outcomes").insert({
          workspace_id: wsId,
          customer_id: session.customer_id,
          subscription_id: subData?.id || null,
          cancel_reason: cancelReason,
          remedy_type: "none",
          accepted: false,
          outcome: "cancelled",
          customer_ltv_cents: customerLtv,
          subscription_age_days: subAgeDays,
          first_renewal: isFirstRenewal,
        });
      }

      // Tag ticket
      if (session.ticket_id) {
        const { addTicketTag } = await import("@/lib/ticket-tags");
        await addTicketTag(session.ticket_id, "jo:negative");

        await admin.from("tickets").update({
          status: "closed",
          resolved_at: new Date().toISOString(),
          journey_step: 99,
        }).eq("id", session.ticket_id);
      }
    } else if (outcome?.startsWith("saved_")) {
      // Customer accepted a remedy — look up type from DB
      const remedyId = responses?.remedy_selection?.value;

      // Get the actual remedy type from the remedies table
      let actionType = responses?.remedy_action?.value || "unknown";
      if (remedyId) {
        const { data: remedyRow } = await admin.from("remedies").select("type").eq("id", remedyId).maybeSingle();
        if (remedyRow?.type) actionType = remedyRow.type;
      }

      if (selectedSub && actionType !== "unknown") {
        const { appstleSubscriptionAction, appstleSkipNextOrder, appstleUpdateBillingInterval } = await import("@/lib/appstle");

        if (actionType === "pause") {
          const result = await appstleSubscriptionAction(wsId, selectedSub.contractId, "pause");
          actionLog.push(result.success ? `Paused subscription ${selectedSub.contractId}` : `Failed to pause: ${result.error}`);
        } else if (actionType === "skip") {
          const result = await appstleSkipNextOrder(wsId, selectedSub.contractId);
          actionLog.push(result.success ? `Skipped next order for ${selectedSub.contractId}` : `Failed to skip: ${result.error}`);
        } else if (actionType === "frequency_change") {
          const result = await appstleUpdateBillingInterval(wsId, selectedSub.contractId, "MONTH", 2);
          actionLog.push(result.success ? `Changed frequency to every 2 months for ${selectedSub.contractId}` : `Failed to change frequency: ${result.error}`);
        } else if (actionType === "coupon") {
          // Apply coupon via shared helper (removes existing, applies new, updates local DB)
          const couponCode = responses?.remedy_coupon?.value;
          if (couponCode) {
            try {
              const { data: wsData } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", wsId).single();
              if (wsData?.appstle_api_key_encrypted) {
                const { decrypt } = await import("@/lib/crypto");
                const apiKey = decrypt(wsData.appstle_api_key_encrypted);
                const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
                const result = await applyDiscountWithReplace(apiKey, selectedSub.contractId, couponCode);
                if (result.success) {
                  actionLog.push(`Applied coupon ${couponCode} to subscription ${selectedSub.contractId}`);
                } else {
                  actionLog.push(`Failed to apply coupon: ${result.error}`);
                }
              }
            } catch (err) {
              actionLog.push(`Failed to apply coupon: ${err}`);
            }
          }
        }
      }

      // Record remedy outcome
      if (session.customer_id) {
        await admin.from("remedy_outcomes").insert({
          workspace_id: wsId,
          customer_id: session.customer_id,
          cancel_reason: cancelReason,
          remedy_id: remedyId || null,
          remedy_type: responses?.remedy_action?.value || outcome,
          offered_text: responses?.remedy_selection?.label || null,
          accepted: true,
          first_renewal: isFirstRenewal,
          outcome: "saved",
        });
      }

      // Tag ticket positive
      if (session.ticket_id) {
        const { addTicketTag } = await import("@/lib/ticket-tags");
        await addTicketTag(session.ticket_id, "jo:positive");

        await admin.from("tickets").update({
          status: "closed",
          resolved_at: new Date().toISOString(),
          journey_step: 99,
        }).eq("id", session.ticket_id);
      }
    }

    // Log actions as internal note
    if (session.ticket_id) {
      const allActions = [`Cancel reason: ${cancelReasonLabel}`, `Outcome: ${outcome}`, ...actionLog];
      await admin.from("ticket_messages").insert({
        ticket_id: session.ticket_id,
        direction: "outbound",
        visibility: "internal",
        author_type: "system",
        body: `[System] Cancel journey completed:\n${allActions.map(a => `• ${a}`).join("\n")}`,
      });

      // Send customer-facing confirmation
      const confirmMsg = outcome === "cancelled"
        ? "<p>Your subscription has been cancelled. You won't be charged again. You're always welcome back.</p>"
        : "<p>We've updated your subscription. Thank you for staying with us!</p>";

      await admin.from("ticket_messages").insert({
        ticket_id: session.ticket_id,
        direction: "outbound",
        visibility: "external",
        author_type: "system",
        body: confirmMsg,
      });

      // Send email reply for email channel tickets
      const { data: ticketData } = await admin.from("tickets")
        .select("subject, email_message_id, channel, customer_id")
        .eq("id", session.ticket_id)
        .single();

      if (ticketData?.channel === "email" && ticketData.customer_id) {
        const { data: cust } = await admin.from("customers").select("email").eq("id", ticketData.customer_id).single();
        const { data: wsInfo } = await admin.from("workspaces").select("name").eq("id", wsId).single();

        if (cust?.email) {
          const { sendTicketReply } = await import("@/lib/email");
          await sendTicketReply({
            workspaceId: wsId,
            toEmail: cust.email,
            subject: ticketData.subject ? `Re: ${ticketData.subject}` : "Re: Your request",
            body: confirmMsg,
            inReplyTo: ticketData.email_message_id || null,
            agentName: "Support",
            workspaceName: wsInfo?.name || "Support",
          });
        }
      }
    }

    // Mark session completed
    await admin.from("journey_sessions").update({
      status: "completed",
      outcome,
      responses: responses || {},
      completed_at: new Date().toISOString(),
    }).eq("id", session.id);

    const message = outcome === "cancelled"
      ? "Your subscription has been cancelled. You won't be charged again. You're always welcome back."
      : "We've updated your subscription. Thank you for staying with us!";

    return NextResponse.json({ success: true, message });
  }

  // Handle declined — use journey-delivery nudge system
  if (outcome === "declined" && session.ticket_id) {
    const { data: ticketData } = await admin.from("tickets")
      .select("journey_history, channel, customer_id")
      .eq("id", session.ticket_id)
      .single();

    const history = (ticketData?.journey_history as { journey_id: string; nudged_at: string | null }[]) || [];
    const entry = history.find(h => h.journey_id === session.journey_id);

    if (entry && !entry.nudged_at) {
      // First decline — re-nudge via journey-delivery
      const { nudgeJourney } = await import("@/lib/journey-delivery");
      await nudgeJourney(
        session.workspace_id, session.ticket_id,
        { journey_id: session.journey_id, journey_name: "Journey" },
        ticketData?.channel || "email", "Customer declined", null,
      );
    } else {
      // Already nudged or no entry — close ticket
      await admin.from("tickets").update({
        status: "closed",
        resolved_at: new Date().toISOString(),
        journey_data: {},
        journey_nudge_count: 0,
        handled_by: null,
      }).eq("id", session.ticket_id);

      await admin.from("ticket_messages").insert({
        ticket_id: session.ticket_id,
        direction: "outbound",
        visibility: "internal",
        author_type: "system",
        body: "[System] Customer declined marketing signup twice. Journey ended. AI will handle next reply.",
      });

      const { addTicketTag } = await import("@/lib/ticket-tags");
      await addTicketTag(session.ticket_id, "jo:negative");
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

  // Fire Inngest event for outcome processing
  await inngest.send({
    name: "journey/session.completed",
    data: { session_id: session.id, outcome, workspace_id: session.workspace_id },
  });

  // Determine thank-you message
  let message: string;
  if (outcome === "declined") {
    message = "No problem! Let us know if you need anything else.";
  } else if (outcome === "cancelled") {
    message = "Your subscription has been cancelled.";
  } else if (outcome?.startsWith("saved_")) {
    message = "Great news! We've updated your subscription.";
  } else {
    message = "All done! We've updated your account.";
  }

  return NextResponse.json({ success: true, message });
}
