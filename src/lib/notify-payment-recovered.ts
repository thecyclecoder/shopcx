import { createAdminClient } from "@/lib/supabase/admin";
import { getSlackToken, postMessage } from "@/lib/slack";

/**
 * DM the workspace owners/admins when a customer self-serves a payment-method
 * recovery (used the magic recovery link → added a card → subs migrated/pinned).
 * Direct DM (not the slack_notification_rules system) so it always reaches the
 * team without per-event config. Best-effort — never throws.
 */
export async function notifyPaymentRecovered(
  workspaceId: string,
  info: { customerName: string; email: string; brand: string | null; last4: string | null; migratedCount: number; pinnedCount: number },
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

    const card = info.brand || info.last4 ? `${info.brand || "Card"} ••${info.last4 || "----"}` : "a new card";
    const lines = [
      `:credit_card: *Payment method recovered*`,
      `*${info.customerName || info.email}* (${info.email}) added ${card} via the recovery link.`,
      info.migratedCount > 0 ? `• Migrated ${info.migratedCount} subscription${info.migratedCount === 1 ? "" : "s"} to internal billing` : null,
      info.pinnedCount > 0 ? `• Assigned the new card to ${info.pinnedCount} subscription${info.pinnedCount === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    const text = lines.join("\n");
    const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];

    for (const uid of userIds) {
      await postMessage(token, uid, blocks, "Payment method recovered");
    }
  } catch (e) {
    console.warn("[notify-payment-recovered] failed (non-fatal):", e instanceof Error ? e.message : e);
  }
}
