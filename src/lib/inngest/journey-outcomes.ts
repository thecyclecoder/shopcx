// Inngest functions for journey outcome processing

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

export const journeySessionCompleted = inngest.createFunction(
  {
    id: "journey-session-completed",
    retries: 2,
    triggers: [{ event: "journey/session.completed" }],
  },
  async ({ event, step }) => {
    const { session_id, outcome, workspace_id } = event.data as {
      session_id: string;
      outcome: string;
      workspace_id: string;
    };

    // Step 1: Fetch full session context
    const session = await step.run("fetch-session", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("journey_sessions")
        .select("*, customers(id, email, first_name, last_name, subscription_status), subscriptions(id, status), tickets(id, status)")
        .eq("id", session_id)
        .single();
      return data;
    });

    if (!session || session.outcome_action_taken) {
      return { skipped: true, reason: session ? "already_processed" : "not_found" };
    }

    // Step 2: Execute outcome action
    await step.run("execute-action", async () => {
      const admin = createAdminClient();
      const config = session.config_snapshot as { outcomes?: { key: string; action: { type: string; params: Record<string, unknown> }; label: string }[] } || {};
      const outcomeConfig = (config.outcomes || []).find((o) => o.key === outcome);
      const ticketId = session.ticket_id;
      const responses = session.responses as Record<string, { value: string; label: string }>;
      const reason = responses?.cancellation_reason?.label || outcome;

      // Add internal ticket note summarizing the journey
      if (ticketId) {
        const stepSummary = Object.entries(responses)
          .map(([key, val]) => `${key}: ${val.label}`)
          .join("\n");

        await admin.from("ticket_messages").insert({
          ticket_id: ticketId,
          direction: "outbound",
          body: `[Journey Completed]\nOutcome: ${outcome}\n\n${stepSummary}`,
          author_type: "system",
          visibility: "internal",
        });
      }

      // Execute action based on outcome type
      if (outcome === "cancelled") {
        // Cancel subscription via Appstle API
        if (session.subscription_id) {
          const { data: subData } = await admin
            .from("subscriptions")
            .select("shopify_contract_id")
            .eq("id", session.subscription_id)
            .single();

          if (subData?.shopify_contract_id) {
            const { appstleSubscriptionAction } = await import("@/lib/appstle");
            await appstleSubscriptionAction(
              workspace_id,
              subData.shopify_contract_id,
              "cancel",
              `customer_request: ${reason}`,
              "Customer via cancel journey",
            );
          } else {
            await admin
              .from("subscriptions")
              .update({ status: "cancelled" })
              .eq("id", session.subscription_id);
          }
        }
        // Close ticket
        if (ticketId) {
          await admin
            .from("tickets")
            .update({ status: "closed", resolved_at: new Date().toISOString() })
            .eq("id", ticketId);
        }
      } else if (outcome === "saved_changed_mind") {
        // Customer decided to stay — close ticket with positive note
        if (ticketId) {
          await admin.from("ticket_messages").insert({
            ticket_id: ticketId,
            direction: "outbound",
            body: "[Customer completed cancellation journey and decided to keep their subscription]",
            author_type: "system",
            visibility: "internal",
          });
          await admin
            .from("tickets")
            .update({ status: "closed", resolved_at: new Date().toISOString() })
            .eq("id", ticketId);
        }
      } else if (outcome.startsWith("saved_pause")) {
        // Pause subscription via Appstle API
        const weeks = outcomeConfig?.action?.params?.weeks || 8;
        if (session.subscription_id) {
          const { data: subData } = await admin
            .from("subscriptions")
            .select("shopify_contract_id")
            .eq("id", session.subscription_id)
            .single();

          if (subData?.shopify_contract_id) {
            const { appstleSubscriptionAction } = await import("@/lib/appstle");
            await appstleSubscriptionAction(workspace_id, subData.shopify_contract_id, "pause");
          } else {
            await admin.from("subscriptions").update({ status: "paused" }).eq("id", session.subscription_id);
          }
        }
        if (ticketId) {
          await admin.from("ticket_messages").insert({
            ticket_id: ticketId,
            direction: "outbound",
            body: `[Customer chose to pause subscription for ${weeks} weeks via journey]`,
            author_type: "system",
            visibility: "internal",
          });
          await admin
            .from("tickets")
            .update({ status: "closed", resolved_at: new Date().toISOString() })
            .eq("id", ticketId);
        }
      } else if (outcome === "saved_discount") {
        // Discount — assign to agent for manual application
        if (ticketId) {
          await admin.from("ticket_messages").insert({
            ticket_id: ticketId,
            direction: "outbound",
            body: `[Customer accepted discount offer via journey. Apply 20% off for 3 months. Reason: ${reason}]`,
            author_type: "system",
            visibility: "internal",
          });
          await admin
            .from("tickets")
            .update({ status: "open" })
            .eq("id", ticketId);
        }
      } else if (outcome === "saved_skip") {
        // Skip next order via Appstle API
        if (session.subscription_id) {
          const { data: subData } = await admin
            .from("subscriptions")
            .select("shopify_contract_id")
            .eq("id", session.subscription_id)
            .single();

          if (subData?.shopify_contract_id) {
            const { appstleSkipNextOrder } = await import("@/lib/appstle");
            await appstleSkipNextOrder(workspace_id, subData.shopify_contract_id);
          }
        }
        if (ticketId) {
          await admin.from("ticket_messages").insert({
            ticket_id: ticketId,
            direction: "outbound",
            body: "[Customer chose to skip next order via journey]",
            author_type: "system",
            visibility: "internal",
          });
          await admin.from("tickets").update({ status: "closed", resolved_at: new Date().toISOString() }).eq("id", ticketId);
        }
      } else if (outcome === "saved_coach" || outcome === "saved_swap") {
        // Needs human follow-up
        if (ticketId) {
          await admin.from("ticket_messages").insert({
            ticket_id: ticketId,
            direction: "outbound",
            body: `[Customer requested ${outcome === "saved_coach" ? "product specialist" : "product swap"} via journey. Manual follow-up needed.]`,
            author_type: "system",
            visibility: "internal",
          });
          await admin.from("tickets").update({ status: "open" }).eq("id", ticketId);
        }
      } else {
        // Generic close
        if (ticketId) {
          await admin.from("tickets").update({ status: "closed", resolved_at: new Date().toISOString() }).eq("id", ticketId);
        }
      }
    });

    // Step 3: Apply outcome tags
    await step.run("apply-tags", async () => {
      if (!session.ticket_id) return;
      const { addTicketTag } = await import("@/lib/ticket-tags");
      if (outcome === "cancelled") {
        await addTicketTag(session.ticket_id, "jo:negative");
      } else if (outcome.startsWith("saved_")) {
        await addTicketTag(session.ticket_id, "jo:positive");
      }
    });

    // Step 4: Mark action taken (idempotency)
    await step.run("mark-action-taken", async () => {
      const admin = createAdminClient();
      await admin
        .from("journey_sessions")
        .update({ outcome_action_taken: true })
        .eq("id", session_id);
    });

    // Step 5: Update retention score
    await step.run("update-retention", async () => {
      if (!session.customer_id) return;
      const admin = createAdminClient();
      const { data: customer } = await admin
        .from("customers")
        .select("retention_score")
        .eq("id", session.customer_id)
        .single();
      if (!customer) return;

      let adjustment = 0;
      if (outcome === "cancelled") adjustment = -15;
      else if (outcome === "saved_changed_mind") adjustment = 10;
      else if (outcome.startsWith("saved_")) adjustment = 5;

      const newScore = Math.max(0, Math.min(100, (customer.retention_score || 50) + adjustment));
      await admin
        .from("customers")
        .update({ retention_score: newScore })
        .eq("id", session.customer_id);
    });

    return { outcome, action_taken: true };
  }
);

export const journeySessionAbandoned = inngest.createFunction(
  {
    id: "journey-session-abandoned",
    retries: 1,
    triggers: [{ event: "journey/session.abandoned" }],
  },
  async ({ event, step }) => {
    const { session_id } = event.data as { session_id: string };

    await step.run("handle-abandoned", async () => {
      const admin = createAdminClient();
      const { data: session } = await admin
        .from("journey_sessions")
        .select("ticket_id, current_step, responses")
        .eq("id", session_id)
        .single();

      if (!session?.ticket_id) return;

      const responses = session.responses as Record<string, { value: string; label: string }>;
      const reason = responses?.cancellation_reason?.label || "unknown";

      await admin.from("ticket_messages").insert({
        ticket_id: session.ticket_id,
        direction: "outbound",
        body: `[Journey Abandoned]\nCustomer started the cancellation journey but didn't finish.\nReached step ${session.current_step}.\nReason given: ${reason}\n\nManual follow-up recommended.`,
        author_type: "system",
        visibility: "internal",
      });

      // Assign to agent queue — high priority
      await admin
        .from("tickets")
        .update({ status: "open" })
        .eq("id", session.ticket_id);
    });

    return { handled: true };
  }
);
