import { getSlackToken, postMessage } from "@/lib/slack";

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

    // Slack-cleanup 2026-06-23: only CRITICAL ops alerts push to Slack (the #alerts-critical channel,
    // a real must-act page). Warnings no longer DM everyone — they're on the Control Tower + roll into
    // the #daily-digest. Stops the per-warning DM flood.
    if (alert.severity !== "critical") return;

    const ALERTS_CRITICAL_CHANNEL = "C0BCQ1UME3T"; // #alerts-critical
    const text = [`:rotating_light: *${alert.title}*`, ...(alert.lines || [])].join("\n");
    const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];
    await postMessage(token, ALERTS_CRITICAL_CHANNEL, blocks, alert.title);
  } catch (e) {
    console.warn("[notify-ops-alert] failed:", e instanceof Error ? e.message : e);
  }
}
