import { getSlackToken, postMessage } from "@/lib/slack";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * DM the workspace owners/admins about an operational problem that needs
 * a human — money moved but the system couldn't finish the job (e.g. a
 * charge succeeded but the sub append failed, or tax silently fell to $0).
 *
 * Direct DM (not the configurable slack_notification_rules system) so a
 * money-critical alert always reaches the team without per-event setup.
 * Best-effort — never throws; a Slack outage must not break checkout.
 */
export async function notifyOpsAlert(
  workspaceId: string,
  alert: { title: string; lines?: string[]; severity?: "warning" | "critical" },
): Promise<void> {
  try {
    const token = await getSlackToken(workspaceId);
    if (!token) return;

    const admin = createAdminClient();
    const { data: members } = await admin
      .from("workspace_members")
      .select("slack_user_id")
      .eq("workspace_id", workspaceId)
      .in("role", ["owner", "admin"])
      .not("slack_user_id", "is", null);
    const userIds = (members || []).map((m) => m.slack_user_id as string).filter(Boolean);
    if (!userIds.length) return;

    const icon = alert.severity === "critical" ? ":rotating_light:" : ":warning:";
    const text = [`${icon} *${alert.title}*`, ...(alert.lines || [])].join("\n");
    const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];

    for (const uid of userIds) {
      await postMessage(token, uid, blocks, alert.title);
    }
  } catch (e) {
    console.warn("[notify-ops-alert] failed:", e instanceof Error ? e.message : e);
  }
}
