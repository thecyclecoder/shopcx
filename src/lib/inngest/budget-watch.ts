/**
 * budget-watch — the founder's spend tripwire cron (CEO 2026-07-10). Every ~10 min it checks each active
 * [[../tables/meta_ad_accounts]]'s TOTAL live daily budget (Meta ground truth) and SMSes the founder when
 * it climbs — a new test running, a raised budget, or a runaway. So a sudden "Superfood Tabs daily budget
 * is now $3,000" reaches him fast while traveling. Pure notification, no autonomy. See
 * [[../libraries/budget-alerts]].
 */
import { inngest } from "@/lib/inngest/client";
import { errText } from "@/lib/error-text";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { checkAndAlertAccountBudget } from "@/lib/meta/budget-alerts";

interface AccountRow {
  id: string;
  workspace_id: string;
  meta_account_id: string;
  meta_account_name: string;
  last_notified_daily_budget_cents: number | null;
}

export const budgetWatchCron = inngest.createFunction(
  {
    id: "budget-watch-cron",
    name: "Growth — ad budget increase tripwire (SMS)",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/10 * * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const accounts = await step.run("load-active-accounts", async () => {
      const { data } = await admin
        .from("meta_ad_accounts")
        .select("id, workspace_id, meta_account_id, meta_account_name, last_notified_daily_budget_cents")
        .eq("is_active", true);
      return (data ?? []) as AccountRow[];
    });

    let alerted = 0;
    let checked = 0;
    for (const account of accounts) {
      const r = await step.run(`check-${account.id}`, async () => {
        try {
          return await checkAndAlertAccountBudget(admin, account);
        } catch (e) {
          return { accountName: account.meta_account_name, totalCents: 0, prevCents: account.last_notified_daily_budget_cents, increased: false, smsSent: false, smsError: errText(e) };
        }
      });
      checked++;
      if (r.smsSent) alerted++;
      if (r.increased || r.smsError) {
        console.log(`[budget-watch] ${r.accountName}: total=$${(r.totalCents / 100).toFixed(0)} prev=${r.prevCents == null ? "—" : "$" + (r.prevCents / 100).toFixed(0)} increased=${r.increased} sms=${r.smsSent}${r.smsError ? " err=" + r.smsError : ""}`);
      }
    }

    const result = { checked, alerted };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("budget-watch-cron", { ok: true, produced: result, detail: `checked ${checked} account(s), ${alerted} SMS` });
    });
    return result;
  },
);
