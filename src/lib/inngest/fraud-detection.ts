import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAllFraudRules, checkOrderForFraud, checkCustomerForFraud } from "@/lib/fraud-detector";

// ── Nightly full scan ──

export const fraudNightlyScan = inngest.createFunction(
  {
    id: "fraud-nightly-scan",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspaceId" }],
    triggers: [{ cron: "0 3 * * *" }], // 3am UTC daily
  },
  async ({ step }: { step: any }) => {
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
  async ({ event, step }: { event: any; step: any }) => {
    const { caseId, workspaceId } = event.data as { caseId: string; workspaceId: string };
    const admin = createAdminClient();

    const fraudCase = await step.run("load-case", async () => {
      const { data } = await admin
        .from("fraud_cases")
        .select("id, evidence, rule_type, severity, title")
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
          model: "claude-haiku-4-5-20251001",
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
  async ({ event, step }: { event: any; step: any }) => {
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
  async ({ event, step }: { event: any; step: any }) => {
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
  async ({ event, step }: { event: any; step: any }) => {
    const { workspaceId } = event.data as { workspaceId: string };

    await step.run("rerun-detection", async () => {
      await runAllFraudRules(workspaceId);
    });
  }
);
