import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const ticketUnsnooze = inngest.createFunction(
  {
    id: "ticket-unsnooze",
    retries: 1,
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) => {
    const result = await step.run("unsnooze-tickets", async () => {
      const admin = createAdminClient();
      const { data: snoozed } = await admin
        .from("tickets")
        .select("id")
        .lte("snoozed_until", new Date().toISOString())
        .not("snoozed_until", "is", null);

      for (const ticket of snoozed || []) {
        await admin
          .from("tickets")
          .update({
            snoozed_until: null,
            status: "open",
            updated_at: new Date().toISOString(),
          })
          .eq("id", ticket.id);
      }

      return { unsnoozed: snoozed?.length || 0 };
    });

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("ticket-unsnooze", { ok: true, produced: result });
    });
    return result;
  }
);
