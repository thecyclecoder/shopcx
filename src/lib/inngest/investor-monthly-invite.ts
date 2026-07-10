// Monthly investor update: on the 20th, email + text every investor/owner a
// personal magic link to the /investors charts, wrapped in a plain-language
// performance story. Also fires on the `investors/send-invites` event for a
// manual re-send. See docs/brain/lifecycles/investors-area.md.

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { generateInvestorMagicLink, isInvestorRole } from "@/lib/investors/auth";
import { buildInvestorPerformance, renderInvestorEmailHtml, renderInvestorSms } from "@/lib/investor-update";
import { sendInvestorUpdateEmail } from "@/lib/email";
import { sendSMS } from "@/lib/twilio";
import { backfillPnlSnapshots } from "@/lib/quickbooks";
import { QB_REFRESH_MONTHS } from "./qb-snapshot-refresh";

interface SendEventData {
  workspaceId?: string; // limit to one workspace
  onlyCustomerId?: string; // send to a single investor (test / re-send)
  skipSms?: boolean;
  skipRefresh?: boolean; // skip the pre-send QBO re-pull (test sends)
}

export const investorMonthlyInvite = inngest.createFunction(
  {
    id: "investor-monthly-invite",
    retries: 1,
    triggers: [
      { cron: "0 14 20 * *" }, // 20th of each month, ~10am AST / 9am CDT
      { event: "investors/send-invites" }, // manual re-send
    ],
  },
  async ({ step, event }) => {
    const admin = createAdminClient();
    const data = (event?.data ?? {}) as SendEventData;

    const workspaces = await step.run("get-workspaces", async () => {
      if (data.workspaceId) return [{ id: data.workspaceId }];
      // Only workspaces that actually have investor/owner customers.
      const { data: rows } = await admin
        .from("customers")
        .select("workspace_id")
        .in("comp_role", ["investor", "owner"]);
      return [...new Set((rows ?? []).map((r) => r.workspace_id as string))].map((id) => ({ id }));
    });

    let emailed = 0;
    let texted = 0;
    const errors: string[] = [];

    for (const ws of workspaces) {
      // Freshen the books before we report. The 20th is past the ~15th QBO close,
      // so the latest closed month is final; re-pulling the trailing 6 also folds
      // in any late entries that changed older months. Non-fatal — if QBO is down
      // we still send from the last-good snapshots.
      if (!data.skipRefresh) {
        await step.run(`refresh-${ws.id}`, async () => {
          try {
            await backfillPnlSnapshots(ws.id, QB_REFRESH_MONTHS, admin);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        });
      }

      const result = await step.run(`send-${ws.id}`, async () => {
        const perf = await buildInvestorPerformance(ws.id, admin);
        if (!perf) return { emailed: 0, texted: 0, errors: [`no snapshots for ${ws.id}`] };

        let q = admin
          .from("customers")
          .select("id, first_name, email, phone, comp_role")
          .eq("workspace_id", ws.id)
          .in("comp_role", ["investor", "owner"]);
        if (data.onlyCustomerId) q = q.eq("id", data.onlyCustomerId);
        const { data: investors } = await q;

        let e = 0;
        let t = 0;
        const errs: string[] = [];
        for (const inv of investors ?? []) {
          if (!isInvestorRole(inv.comp_role) || !inv.email) continue;
          const link = generateInvestorMagicLink(inv.id, inv.email, ws.id);
          const emailRes = await sendInvestorUpdateEmail({
            workspaceId: ws.id,
            toEmail: inv.email,
            subject: `Superfoods investor update — ${perf.latestMonthLabel}`,
            html: renderInvestorEmailHtml({ firstName: inv.first_name, link, perf }),
          });
          if (emailRes.error) errs.push(`${inv.email}: ${emailRes.error}`);
          else e++;

          if (!data.skipSms && inv.phone) {
            const smsRes = await sendSMS(ws.id, inv.phone, renderInvestorSms(perf, link));
            if (smsRes.success) t++;
            else if (smsRes.error) errs.push(`${inv.phone}: ${smsRes.error}`);
          }
        }
        return { emailed: e, texted: t, errors: errs };
      });
      emailed += result.emailed;
      texted += result.texted;
      errors.push(...result.errors);
    }

    const summary = { workspaces: workspaces.length, emailed, texted, errors };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("investor-monthly-invite", { ok: errors.length === 0, produced: summary });
    });
    return summary;
  },
);
