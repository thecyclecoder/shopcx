/**
 * Portal-action healer cron.
 *
 * "Portal action needs help" tickets are created when a customer hits an error
 * doing a self-serve portal action. They carry no customer message, so the AI
 * pipeline never runs on them. This cron triages every open one every 15 min:
 *
 *   • transient Appstle/infra errors  → re-run the action, close on success
 *   • user/UI validation errors       → auto-dismiss (close, tagged)
 *   • anything unrecognized           → tag needs-human, leave open
 *
 * All the logic lives in `@/lib/portal/remediation` so the manual one-off pass
 * and this cron behave identically. See docs/brain/recipes/portal-action-healer.md
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchOpenPortalFailures, remediatePortalTicket } from "@/lib/portal/remediation";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const portalActionHealer = inngest.createFunction(
  {
    id: "portal-action-healer",
    name: "Portal — heal / dismiss failed self-serve actions",
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/15 * * * *" }, { event: "portal/heal.tick" }],
  },
  async ({ step }) => {
    const workspaces = await step.run("load-workspaces", async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("workspaces").select("id");
      return (data || []).map((w) => w.id as string);
    });

    const tally = { healed: 0, dismissed: 0, escalated: 0, retry_pending: 0, skipped: 0 };

    for (const wsId of workspaces) {
      const outcomes = await step.run(`remediate-${wsId}`, async () => {
        const admin = createAdminClient();
        const tickets = await fetchOpenPortalFailures(admin, wsId);
        const results: string[] = [];
        for (const t of tickets) {
          const out = await remediatePortalTicket(admin, t);
          results.push(out.action);
        }
        return results;
      });
      for (const a of outcomes) {
        if (a in tally) tally[a as keyof typeof tally]++;
      }
    }

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("portal-action-healer", { ok: true, produced: tally });
    });

    return tally;
  },
);
