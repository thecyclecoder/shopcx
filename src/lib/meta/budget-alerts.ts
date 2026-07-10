/**
 * budget-alerts — the founder's spend tripwire (CEO 2026-07-10). Whenever an ad account's TOTAL active
 * daily budget climbs — a new test adset running, a raised budget, or a runaway ("Superfood Tabs daily
 * budget is now $3,000" = something's wrong) — text the founder so he can catch it fast while traveling.
 *
 * Ground truth from Meta (not our synced tables, which lag): sum `daily_budget` across ACTIVE adsets +
 * ACTIVE CBO campaigns per account. Compared each pass against `meta_ad_accounts.last_notified_daily_budget_cents`;
 * an INCREASE fires one SMS via [[../twilio]] `sendSMS` to [[../god-mode]] `resolveFounderPhone`, then the
 * baseline is updated. Driven by [[../inngest/budget-watch]] every ~10 min. See [[../../../docs/brain/libraries/budget-alerts]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { getMetaUserToken } from "@/lib/meta-ads";
import { sendSMS } from "@/lib/twilio";
import { resolveFounderPhone } from "@/lib/god-mode";

type Admin = ReturnType<typeof createAdminClient>;

const GRAPH = "https://graph.facebook.com/v21.0";
// Meta effective_status values that mean the object is actually delivering (its budget is live spend).
const LIVE_STATUSES = new Set(["ACTIVE", "CAMPAIGN_PAUSED_ADSET_ACTIVE"]);

async function graphGet(path: string, token: string): Promise<{ data?: Array<Record<string, unknown>> }> {
  const res = await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`graph_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * The account's total ACTIVE daily budget in cents = Σ active-adset daily_budget (ABO) + Σ active-CBO-campaign
 * daily_budget. Meta returns `daily_budget` as a string in the account's MINOR units (cents). Objects with no
 * daily_budget (paused, lifetime-budget, or CBO parent of ABO adsets) contribute 0.
 */
export async function accountActiveDailyBudgetCents(token: string, bareMetaAccountId: string): Promise<number> {
  const act = `act_${bareMetaAccountId}`;
  const [adsets, campaigns] = await Promise.all([
    graphGet(`${act}/adsets?fields=daily_budget,effective_status&limit=500`, token),
    graphGet(`${act}/campaigns?fields=daily_budget,effective_status&limit=500`, token),
  ]);
  const sumLive = (rows: Array<Record<string, unknown>> | undefined) =>
    (rows ?? []).reduce((acc, r) => {
      const status = String(r.effective_status ?? "");
      const daily = Number(r.daily_budget ?? 0);
      return LIVE_STATUSES.has(status) && Number.isFinite(daily) ? acc + daily : acc;
    }, 0);
  return sumLive(adsets.data) + sumLive(campaigns.data);
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export interface BudgetCheckResult {
  accountName: string;
  totalCents: number;
  prevCents: number | null;
  increased: boolean;
  smsSent: boolean;
  smsError?: string;
}

/**
 * Check ONE account: compute its live total daily budget, and if it INCREASED vs the stored baseline, SMS
 * the founder + update the baseline. Always updates the baseline to the current total (so a dip-then-climb
 * re-alerts from the new low). Returns what happened for the cron's log.
 */
export async function checkAndAlertAccountBudget(
  admin: Admin,
  account: { id: string; workspace_id: string; meta_account_id: string; meta_account_name: string; last_notified_daily_budget_cents: number | null },
): Promise<BudgetCheckResult> {
  const token = await getMetaUserToken(account.workspace_id);
  if (!token) return { accountName: account.meta_account_name, totalCents: 0, prevCents: account.last_notified_daily_budget_cents, increased: false, smsSent: false, smsError: "no_meta_token" };

  const totalCents = await accountActiveDailyBudgetCents(token, account.meta_account_id);
  const prevCents = account.last_notified_daily_budget_cents;
  const increased = prevCents != null && totalCents > prevCents;

  let smsSent = false;
  let smsError: string | undefined;
  if (increased) {
    const to = await resolveFounderPhone(admin, account.workspace_id);
    if (to) {
      const body = `${account.meta_account_name} daily budget is now ${dollars(totalCents)}/day (was ${dollars(prevCents!)}). If that looks wrong, pause it.`;
      const r = await sendSMS(account.workspace_id, to, body);
      smsSent = r.success;
      if (!r.success) smsError = r.error;
    } else {
      smsError = "no_founder_phone";
    }
  }

  // Update the baseline to the current total (first-ever check just seeds it — no SMS since prev was null).
  await admin.from("meta_ad_accounts").update({ last_notified_daily_budget_cents: totalCents }).eq("id", account.id);

  return { accountName: account.meta_account_name, totalCents, prevCents, increased, smsSent, smsError };
}
