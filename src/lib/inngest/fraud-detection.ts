import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAllFraudRules, checkOrderForFraud, checkCustomerForFraud } from "@/lib/fraud-detector";
import { decrypt } from "@/lib/crypto";
import { unsubscribeFromAllMarketing } from "@/lib/shopify-marketing";
import { dispatchSlackNotification } from "@/lib/slack-notify";
import { HAIKU_MODEL } from "@/lib/ai-models";

// ── Nightly full scan ──

export const fraudNightlyScan = inngest.createFunction(
  {
    id: "fraud-nightly-scan",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspaceId" }],
    triggers: [{ cron: "0 3 * * *" }], // 3am UTC daily
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaces = await step.run("load-workspaces", async () => {
      const { data } = await admin
        .from("workspaces")
        .select("id")
        .not("shopify_shop_domain", "is", null);
      return data || [];
    });

    for (const ws of workspaces) {
      await step.run(`scan-${ws.id}`, async () => {
        const results = await runAllFraudRules(ws.id);
        const totalNew = results.reduce((s, r) => s + r.new_cases, 0);
        const totalUpdated = results.reduce((s, r) => s + r.updated_cases, 0);
        console.log(`Fraud scan for ${ws.id}: ${totalNew} new, ${totalUpdated} updated`);
        return { new_cases: totalNew, updated_cases: totalUpdated };
      });

      // Poll Shopify for new disputes/chargebacks
      await step.run(`poll-disputes-${ws.id}`, async () => {
        const admin = createAdminClient();
        const { data: workspace } = await admin
          .from("workspaces")
          .select("shopify_myshopify_domain, shopify_access_token_encrypted")
          .eq("id", ws.id)
          .single();

        if (!workspace?.shopify_access_token_encrypted) return { disputes: 0 };

        const shop = workspace.shopify_myshopify_domain;
        const accessToken = decrypt(workspace.shopify_access_token_encrypted);
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        try {
          const res = await fetch(
            `https://${shop}/admin/api/2025-01/shopify_payments/disputes.json?limit=50&initiated_at_min=${oneDayAgo}`,
            { headers: { "X-Shopify-Access-Token": accessToken } }
          );

          if (!res.ok) return { disputes: 0, error: `${res.status}` };
          const data = await res.json();

          const REASON_MAP: Record<string, string> = {
            subscription_canceled: "subscription_cancelled",
            fraudulent: "fraudulent",
            unrecognized: "unrecognized",
            duplicate: "duplicate",
            product_unacceptable: "product_unacceptable",
            product_not_received: "product_not_received",
            credit_not_processed: "credit_not_processed",
          };
          const STATUS_MAP: Record<string, string> = {
            needs_response: "under_review",
            under_review: "under_review",
            accepted: "accepted",
            won: "won",
            lost: "lost",
          };

          let imported = 0;
          for (const d of data.disputes || []) {
            const { data: order } = await admin
              .from("orders")
              .select("customer_id")
              .eq("workspace_id", ws.id)
              .eq("shopify_order_id", String(d.order_id))
              .single();

            const { error } = await admin.from("chargeback_events").upsert({
              workspace_id: ws.id,
              shopify_dispute_id: String(d.id),
              shopify_order_id: String(d.order_id),
              customer_id: order?.customer_id || null,
              dispute_type: d.type || "chargeback",
              reason: REASON_MAP[d.reason] || null,
              network_reason_code: d.network_reason_code,
              amount_cents: Math.round(parseFloat(d.amount) * 100),
              currency: d.currency,
              status: STATUS_MAP[d.status] || "under_review",
              evidence_due_by: d.evidence_due_by,
              evidence_sent_on: d.evidence_sent_on,
              finalized_on: d.finalized_on,
              initiated_at: d.initiated_at,
              raw_payload: d,
            }, { onConflict: "workspace_id,shopify_dispute_id" });

            if (!error) {
              imported++;
              await inngest.send({
                name: "chargeback/received",
                data: { chargebackEventId: String(d.id), workspaceId: ws.id },
              });
            }
          }

          return { disputes: imported };
        } catch {
          return { disputes: 0, error: "fetch failed" };
        }
      });
    }
  }
);

// ── AI summary generation ──

export const fraudGenerateSummary = inngest.createFunction(
  {
    id: "fraud-generate-summary",
    retries: 2,
    triggers: [{ event: "fraud/case.created" }],
  },
  async ({ event, step }) => {
    const { caseId, workspaceId } = event.data as { caseId: string; workspaceId: string };
    const admin = createAdminClient();

    const fraudCase = await step.run("load-case", async () => {
      const { data } = await admin
        .from("fraud_cases")
        .select("id, evidence, rule_type, severity, title, customer_ids")
        .eq("id", caseId)
        .single();
      return data;
    });

    if (!fraudCase) return;

    const summary = await step.run("generate-summary", async () => {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY!,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: `You are a fraud analyst assistant. Based on the following evidence, write a 2-3 sentence plain-English summary of why this was flagged, what the risk level is, and what an admin should look for when reviewing it. Be specific and factual. Do not use legal language. Do not say "confirmed fraud" — say "suspicious pattern."\n\nRule type: ${fraudCase.rule_type}\nSeverity: ${fraudCase.severity}\nEvidence: ${JSON.stringify(fraudCase.evidence)}`,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status}`);
      }

      const result = await response.json();
      return (result.content?.[0]?.text as string) || "";
    });

    await step.run("save-summary", async () => {
      await admin
        .from("fraud_cases")
        .update({ summary })
        .eq("id", caseId);

      // Create or update dashboard notification
      const severityLabel = fraudCase.severity.toUpperCase();
      const firstSentence = summary.split(". ")[0] + ".";

      // Check if notification already exists for this case
      const { data: existingNotif } = await admin
        .from("dashboard_notifications")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("type", "fraud_alert")
        .eq("metadata->>entity_id", caseId)
        .maybeSingle();

      if (existingNotif) {
        await admin
          .from("dashboard_notifications")
          .update({ body: firstSentence })
          .eq("id", existingNotif.id);
      } else {
        await admin.from("dashboard_notifications").insert({
          workspace_id: workspaceId,
          type: "fraud_alert",
          title: `[${severityLabel}] Fraud Alert — ${fraudCase.title}`,
          body: firstSentence,
          link: `/dashboard/fraud?case=${caseId}`,
          metadata: { entity_id: caseId, entity_type: "fraud_case", severity: fraudCase.severity },
        });
      }
    });

    // Slack notification for new fraud case
    dispatchSlackNotification(workspaceId, "fraud_case", {
      customer: { name: fraudCase.title, email: "" },
      severity: fraudCase.severity,
      rules: [],
      caseId,
    }).catch(() => {});

    // Unsubscribe all flagged customers from email + SMS marketing
    await step.run("unsubscribe-flagged-customers", async () => {
      const customerIds = (fraudCase.customer_ids as string[]) || [];
      for (const custId of customerIds) {
        await unsubscribeFromAllMarketing(workspaceId, custId);
      }
    });
  }
);

// ── Real-time: check new order ──

export const fraudCheckOrder = inngest.createFunction(
  {
    id: "fraud-check-order",
    retries: 2,
    concurrency: [{ limit: 3, key: "event.data.workspaceId" }],
    triggers: [{ event: "fraud/order.check" }],
  },
  async ({ event, step }) => {
    const { orderId, customerId, workspaceId } = event.data as {
      orderId: string;
      customerId: string | null;
      workspaceId: string;
    };

    await step.run("check-order", async () => {
      await checkOrderForFraud(workspaceId, orderId, customerId);
    });
  }
);

// ── Real-time: check new customer ──

export const fraudCheckCustomer = inngest.createFunction(
  {
    id: "fraud-check-customer",
    retries: 2,
    concurrency: [{ limit: 3, key: "event.data.workspaceId" }],
    triggers: [{ event: "fraud/customer.check" }],
  },
  async ({ event, step }) => {
    const { customerId, workspaceId } = event.data as {
      customerId: string;
      workspaceId: string;
    };

    await step.run("check-customer", async () => {
      await checkCustomerForFraud(workspaceId, customerId);
    });
  }
);

// ── On-demand: re-run specific rule after config change ──

export const fraudRerunRule = inngest.createFunction(
  {
    id: "fraud-rerun-rule",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspaceId" }],
    triggers: [{ event: "fraud/rule.updated" }],
  },
  async ({ event, step }) => {
    const { workspaceId } = event.data as { workspaceId: string };

    await step.run("rerun-detection", async () => {
      await runAllFraudRules(workspaceId);
    });
  }
);
