/**
 * Crisis Campaign — Daily cron that sends tiered outreach to affected subscribers.
 *
 * Runs daily. For each active crisis:
 * 1. Find subs with affected item + next_billing_date within lead_time_days
 * 2. Auto-swap item to default flavor + send Tier 1 email
 * 3. Advance existing records through tiers based on rejection + wait time
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTicketReply } from "@/lib/email";
import crypto from "crypto";

/** Look up a crisis journey definition ID by trigger intent */
async function getCrisisJourneyId(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  triggerIntent: string,
): Promise<string | null> {
  const { data } = await admin.from("journey_definitions")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("trigger_intent", triggerIntent)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  return data?.id || null;
}

export const crisisDailyCampaign = inngest.createFunction(
  {
    id: "crisis-daily-campaign",
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 13 * * *" }], // 8 AM Central = 13:00 UTC
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Get all active crisis events
    const crises = await step.run("get-active-crises", async () => {
      const { data } = await admin.from("crisis_events")
        .select("*")
        .eq("status", "active");
      return data || [];
    });

    if (crises.length === 0) return { status: "no_active_crises" };

    let totalNew = 0;

    for (const crisis of crises) {
      // ── Step 1: Find new eligible subscriptions ──
      const newActions = await step.run(`find-new-${crisis.id.slice(0, 8)}`, async () => {
        const affectedSku = crisis.affected_sku;
        const affectedVariantId = crisis.affected_variant_id;
        const leadDays = crisis.lead_time_days || 7;
        const cutoffDate = new Date(Date.now() + leadDays * 24 * 60 * 60 * 1000).toISOString();

        // Get all active subs (including those in dunning)
        const { data: allSubs } = await admin.from("subscriptions")
          .select("id, customer_id, shopify_contract_id, status, items, next_billing_date")
          .eq("workspace_id", crisis.workspace_id)
          .in("status", ["active", "paused"]) // include paused for dunning
          .lte("next_billing_date", cutoffDate);

        // Also get dunning subs
        const { data: dunningCycles } = await admin.from("dunning_cycles")
          .select("subscription_id")
          .eq("workspace_id", crisis.workspace_id)
          .eq("status", "active");
        const dunningSubIds = new Set((dunningCycles || []).map(d => d.subscription_id));

        // Filter to subs with affected item
        const eligible = (allSubs || []).filter(s => {
          if (s.status === "paused" && !dunningSubIds.has(s.id)) return false; // only include paused if in dunning
          const items = (s.items as { sku?: string; variant_id?: string; title?: string }[]) || [];
          return items.some(i =>
            (i.sku && i.sku.toUpperCase() === affectedSku?.toUpperCase()) ||
            (i.variant_id && i.variant_id === affectedVariantId)
          );
        });

        // Exclude already processed
        const { data: existing } = await admin.from("crisis_customer_actions")
          .select("subscription_id")
          .eq("crisis_id", crisis.id);
        const processedSubIds = new Set((existing || []).map(e => e.subscription_id));

        const newSubs = eligible.filter(s => !processedSubIds.has(s.id));
        return newSubs.map(s => ({
          subId: s.id,
          customerId: s.customer_id,
          contractId: s.shopify_contract_id,
          items: s.items,
        }));
      });

      // ── Step 2: Process new subs — auto-swap + send Tier 1 ──
      for (const sub of newActions) {
        await step.run(`tier1-${sub.subId.slice(0, 8)}`, async () => {
          const items = (sub.items as { title: string; quantity: number; sku?: string; variant_id?: string }[]) || [];
          const realItems = items.filter(i => !i.title.toLowerCase().includes("shipping protection") && !i.title.toLowerCase().includes("insure"));
          const affectedItem = realItems.find(i =>
            (i.sku && i.sku.toUpperCase() === crisis.affected_sku?.toUpperCase()) ||
            (i.variant_id && i.variant_id === crisis.affected_variant_id)
          );
          if (!affectedItem) return;

          const nonAffectedItems = realItems.filter(i => i !== affectedItem);
          const segment = nonAffectedItems.length === 0 ? "berry_only" : "berry_plus";

          // Auto-swap the item to default flavor via Appstle
          if (crisis.default_swap_variant_id && sub.contractId) {
            try {
              const { subSwapVariant } = await import("@/lib/subscription-items");
              await subSwapVariant(
                crisis.workspace_id,
                sub.contractId,
                affectedItem.variant_id || crisis.affected_variant_id,
                crisis.default_swap_variant_id,
                affectedItem.quantity || 1,
              );
            } catch { /* non-fatal */ }
          }

          // Create a ticket for this customer
          const { data: ticket } = await admin.from("tickets").insert({
            workspace_id: crisis.workspace_id,
            customer_id: sub.customerId,
            subject: `${crisis.name} — subscription update`,
            status: "closed",
            channel: "email",
            tags: ["crisis", `crisis:${crisis.id.slice(0, 8)}`, "touched", "ft:journey"],
            handled_by: `Crisis: ${crisis.name}`,
          }).select("id").single();

          // Record the action
          const { data: actionRecord } = await admin.from("crisis_customer_actions").insert({
            crisis_id: crisis.id,
            workspace_id: crisis.workspace_id,
            subscription_id: sub.subId,
            customer_id: sub.customerId,
            segment,
            original_item: affectedItem,
            current_tier: 1,
            tier1_sent_at: new Date().toISOString(),
            ticket_id: ticket?.id || null,
          }).select("id").single();

          // Create a journey session for Tier 1 flavor swap
          const token = crypto.randomBytes(24).toString("hex");
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 day expiry for crisis
          const tier1JourneyId = await getCrisisJourneyId(admin, crisis.workspace_id, "crisis_tier1");
          await admin.from("journey_sessions").insert({
            workspace_id: crisis.workspace_id,
            journey_id: tier1JourneyId,
            customer_id: sub.customerId,
            ticket_id: ticket?.id || null,
            token,
            token_expires_at: expiresAt,
            status: "pending",
            config_snapshot: {
              codeDriven: true,
              journeyType: "crisis_tier1",
              metadata: {
                crisisId: crisis.id,
                actionId: actionRecord?.id,
                subscriptionId: sub.subId,
                customerId: sub.customerId,
                workspaceId: crisis.workspace_id,
                ticketId: ticket?.id,
                affectedVariantId: crisis.affected_variant_id,
                defaultSwapVariantId: crisis.default_swap_variant_id,
              },
            },
          });

          // Build email with journey link
          const { data: customer } = await admin.from("customers")
            .select("email, first_name").eq("id", sub.customerId).single();
          if (!customer?.email) return;

          const { data: ws } = await admin.from("workspaces")
            .select("name, help_primary_color").eq("id", crisis.workspace_id).single();

          const firstName = customer.first_name || "there";
          const defaultSwap = crisis.default_swap_title || "an available flavor";
          const restockDate = crisis.expected_restock_date
            ? new Date(crisis.expected_restock_date).toLocaleDateString("en-US", { month: "long", year: "numeric" })
            : "a few months";

          const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
          const journeyUrl = `${siteUrl}/journey/${token}`;
          const primaryColor = ws?.help_primary_color || "#4f46e5";

          const emailBody = `<p>Hi ${firstName},</p>
<p>We wanted to let you know that <b>${crisis.affected_product_title || "your item"}</b> is temporarily out of stock. We expect it back by <b>${restockDate}</b>.</p>
<p>To make sure you don't miss your next shipment, we've switched it to <b>${defaultSwap}</b>. ${segment === "berry_plus" ? "Your other items will ship as usual." : ""}</p>
<p>If you'd prefer a different flavor, you can change it here:</p>
<p style="text-align:center;margin:20px 0;"><a href="${journeyUrl}" style="display:inline-block;padding:12px 28px;background:${primaryColor};color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">Choose a Different Flavor →</a></p>
<p style="color:#6b7280;font-size:13px;">If you're happy with ${defaultSwap}, no action needed — your next shipment will include it automatically.</p>`;

          // Insert ticket message
          await admin.from("ticket_messages").insert({
            ticket_id: ticket?.id,
            direction: "outbound",
            visibility: "external",
            author_type: "system",
            body: emailBody,
            sent_at: new Date().toISOString(),
          });

          // Send email
          await sendTicketReply({
            workspaceId: crisis.workspace_id,
            toEmail: customer.email,
            subject: `Update about your ${crisis.affected_product_title || "subscription"}`,
            body: emailBody,
            inReplyTo: null,
            agentName: ws?.name || "Support",
            workspaceName: ws?.name || "",
          });

          totalNew++;
        });

        // Small delay between sends
        await step.sleep("rate-limit", "200ms");
      }

    }

    return { new_tier1: totalNew, crises_processed: crises.length };
  },
);

/**
 * Crisis Advance Tier — Event-driven tier advancement after rejection.
 *
 * Fired immediately when a customer rejects a crisis tier in a journey.
 * Waits only the workspace response delay, then sends the next tier.
 */
export const crisisAdvanceTier = inngest.createFunction(
  {
    id: "crisis-advance-tier",
    concurrency: [{ limit: 5 }],
    triggers: [{ event: "crisis/tier-rejected" }],
  },
  async ({ event, step }) => {
    const {
      crisis_id,
      action_id,
      workspace_id,
      customer_id,
      ticket_id,
      rejected_tier,
      subscription_id,
      segment,
    } = event.data as {
      crisis_id: string;
      action_id: string;
      workspace_id: string;
      customer_id: string;
      ticket_id: string | null;
      rejected_tier: number;
      subscription_id: string;
      segment: string;
    };

    const admin = createAdminClient();

    // Look up workspace response delay for email channel
    const delaySeconds = await step.run("get-response-delay", async () => {
      const { data: ws } = await admin.from("workspaces")
        .select("response_delays")
        .eq("id", workspace_id)
        .single();
      const delays = (ws?.response_delays as Record<string, number> | null) || {};
      return delays.email || 300; // default 5 minutes
    });

    await step.sleep("response-delay", `${delaySeconds}s`);

    // Get crisis details
    const crisis = await step.run("get-crisis", async () => {
      const { data } = await admin.from("crisis_events")
        .select("*")
        .eq("id", crisis_id)
        .single();
      return data;
    });

    if (!crisis) return { status: "crisis_not_found" };

    if (rejected_tier === 1) {
      // ── Send Tier 2: Product swap + coupon ──
      await step.run("send-tier2", async () => {
        const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
        const { data: ws } = await admin.from("workspaces")
          .select("name, help_primary_color").eq("id", workspace_id).single();
        const primaryColor = ws?.help_primary_color || "#4f46e5";
        const couponPct = crisis.tier2_coupon_percent || 20;

        // Create Tier 2 journey session
        const token = crypto.randomBytes(24).toString("hex");
        const tier2JourneyId = await getCrisisJourneyId(admin, workspace_id, "crisis_tier2");
        await admin.from("journey_sessions").insert({
          workspace_id,
          journey_id: tier2JourneyId,
          customer_id,
          ticket_id,
          token,
          token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          status: "pending",
          config_snapshot: {
            codeDriven: true,
            journeyType: "crisis_tier2",
            metadata: {
              crisisId: crisis_id,
              actionId: action_id,
              subscriptionId: subscription_id,
              customerId: customer_id,
              workspaceId: workspace_id,
              ticketId: ticket_id,
              affectedVariantId: crisis.affected_variant_id,
              tier2CouponCode: crisis.tier2_coupon_code,
              tier2CouponPercent: couponPct,
            },
          },
        });

        // Send Tier 2 email
        const { data: customer } = await admin.from("customers")
          .select("email, first_name").eq("id", customer_id).single();
        if (customer?.email) {
          const firstName = customer.first_name || "there";
          const journeyUrl = `${siteUrl}/journey/${token}`;
          const emailBody = `<p>Hi ${firstName},</p>
<p>We understand ${crisis.affected_product_title || "your item"} was your go-to, and we're sorry it's still unavailable.</p>
<p>We'd love to help you try something new — and to sweeten the deal, we'll give you <b>${couponPct}% off</b> your next order when you pick a new product.</p>
<p style="text-align:center;margin:20px 0;"><a href="${journeyUrl}" style="display:inline-block;padding:12px 28px;background:${primaryColor};color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">Browse New Products →</a></p>`;

          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound", visibility: "external", author_type: "system",
            body: emailBody, sent_at: new Date().toISOString(),
          });
          await sendTicketReply({
            workspaceId: workspace_id,
            toEmail: customer.email,
            subject: `${couponPct}% off — try something new while ${crisis.affected_product_title || "your item"} is restocking`,
            body: emailBody,
            inReplyTo: null,
            agentName: ws?.name || "Support",
            workspaceName: ws?.name || "",
          });
        }

        await admin.from("crisis_customer_actions").update({
          current_tier: 2,
          tier2_sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", action_id);
      });

      return { status: "tier2_sent", crisis_id, customer_id };

    } else if (rejected_tier === 2) {
      // ── Send Tier 3: Pause/remove ──
      await step.run("send-tier3", async () => {
        const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
        const { data: ws } = await admin.from("workspaces")
          .select("name, help_primary_color").eq("id", workspace_id).single();
        const primaryColor = ws?.help_primary_color || "#4f46e5";

        // Create Tier 3 journey session
        const token = crypto.randomBytes(24).toString("hex");
        const tier3JourneyId = await getCrisisJourneyId(admin, workspace_id, "crisis_tier3");
        await admin.from("journey_sessions").insert({
          journey_id: tier3JourneyId,
          workspace_id,
          customer_id,
          ticket_id,
          token,
          token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          status: "pending",
          config_snapshot: {
            codeDriven: true,
            journeyType: "crisis_tier3",
            metadata: {
              crisisId: crisis_id,
              actionId: action_id,
              subscriptionId: subscription_id,
              customerId: customer_id,
              workspaceId: workspace_id,
              ticketId: ticket_id,
              segment,
              affectedVariantId: crisis.affected_variant_id,
            },
          },
        });

        const isBerryOnly = segment === "berry_only";
        const restockDate = crisis.expected_restock_date
          ? new Date(crisis.expected_restock_date).toLocaleDateString("en-US", { month: "long", year: "numeric" })
          : "a few months";

        const { data: customer } = await admin.from("customers")
          .select("email, first_name").eq("id", customer_id).single();
        if (customer?.email) {
          const firstName = customer.first_name || "there";
          const journeyUrl = `${siteUrl}/journey/${token}`;
          const emailBody = isBerryOnly
            ? `<p>Hi ${firstName},</p>
<p>We don't want you to go without your supplements. Since ${crisis.affected_product_title || "your item"} won't be back until <b>${restockDate}</b>, we can pause your subscription and automatically restart it the moment it's available.</p>
<p>You won't be charged while paused.</p>
<p style="text-align:center;margin:20px 0;"><a href="${journeyUrl}" style="display:inline-block;padding:12px 28px;background:${primaryColor};color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">Choose What Works for You →</a></p>`
            : `<p>Hi ${firstName},</p>
<p>We can remove ${crisis.affected_product_title || "the out-of-stock item"} from your subscription and keep shipping your other items as usual. We'll automatically add it back when it's in stock (expected <b>${restockDate}</b>).</p>
<p style="text-align:center;margin:20px 0;"><a href="${journeyUrl}" style="display:inline-block;padding:12px 28px;background:${primaryColor};color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">Choose What Works for You →</a></p>`;

          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound", visibility: "external", author_type: "system",
            body: emailBody, sent_at: new Date().toISOString(),
          });
          await sendTicketReply({
            workspaceId: workspace_id,
            toEmail: customer.email,
            subject: `About your ${crisis.affected_product_title || "subscription"} — let us know what you'd prefer`,
            body: emailBody,
            inReplyTo: null,
            agentName: ws?.name || "Support",
            workspaceName: ws?.name || "",
          });
        }

        await admin.from("crisis_customer_actions").update({
          current_tier: 3,
          tier3_sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", action_id);
      });

      return { status: "tier3_sent", crisis_id, customer_id };

    } else if (rejected_tier === 3) {
      // ── Exhausted — mark and TODO: launch cancel journey ──
      await step.run("mark-exhausted", async () => {
        await admin.from("crisis_customer_actions").update({
          current_tier: 4,
          exhausted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", action_id);
      });

      return { status: "exhausted", crisis_id, customer_id };
    }

    return { status: "unknown_tier", rejected_tier };
  },
);
