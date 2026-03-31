// Slack notification dispatcher — non-blocking, fire-and-forget

import { createAdminClient } from "@/lib/supabase/admin";
import {
  getSlackToken,
  postMessage,
  buildEscalationMessage,
  buildChargebackMessage,
  buildFraudMessage,
  buildDunningMessage,
  buildCsatMessage,
  buildCancelMessage,
  buildNewTicketMessage,
} from "@/lib/slack";

type EventType =
  | "escalation"
  | "new_ticket"
  | "chargeback"
  | "fraud_case"
  | "dunning_failed"
  | "csat_negative"
  | "cancel_completed";

const MESSAGE_BUILDERS: Record<EventType, (data: Record<string, unknown>) => { blocks: unknown[]; text: string }> = {
  escalation: (d) => buildEscalationMessage(d as Parameters<typeof buildEscalationMessage>[0]),
  chargeback: (d) => buildChargebackMessage(d as Parameters<typeof buildChargebackMessage>[0]),
  fraud_case: (d) => buildFraudMessage(d as Parameters<typeof buildFraudMessage>[0]),
  dunning_failed: (d) => buildDunningMessage(d as Parameters<typeof buildDunningMessage>[0]),
  csat_negative: (d) => buildCsatMessage(d as Parameters<typeof buildCsatMessage>[0]),
  cancel_completed: (d) => buildCancelMessage(d as Parameters<typeof buildCancelMessage>[0]),
  new_ticket: (d) => buildNewTicketMessage(d as Parameters<typeof buildNewTicketMessage>[0]),
};

export async function dispatchSlackNotification(
  workspaceId: string,
  eventType: EventType,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const token = await getSlackToken(workspaceId);
    if (!token) return;

    const admin = createAdminClient();
    const { data: rule } = await admin
      .from("slack_notification_rules")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("event_type", eventType)
      .single();

    if (!rule?.enabled) return;

    const builder = MESSAGE_BUILDERS[eventType];
    if (!builder) return;

    const { blocks, text } = builder(data);

    // Post to channel
    if (rule.channel_id) {
      await postMessage(token, rule.channel_id, blocks, text);
    }

    // DM assigned agent
    if (rule.dm_assigned_agent && data.assignedMemberId) {
      const { data: member } = await admin
        .from("workspace_members")
        .select("slack_user_id")
        .eq("id", data.assignedMemberId as string)
        .single();
      if (member?.slack_user_id) {
        await postMessage(token, member.slack_user_id, blocks, text);
      }
    }

    // DM admins
    if (rule.dm_admins) {
      const { data: admins } = await admin
        .from("workspace_members")
        .select("slack_user_id")
        .eq("workspace_id", workspaceId)
        .in("role", ["owner", "admin"])
        .not("slack_user_id", "is", null);

      for (const adm of admins || []) {
        if (adm.slack_user_id) {
          await postMessage(token, adm.slack_user_id, blocks, text);
        }
      }
    }
  } catch (err) {
    console.error(`[Slack] notification error (${eventType}):`, err);
  }
}
