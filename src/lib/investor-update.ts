import { createAdminClient } from "@/lib/supabase/admin";

// ─── Investor update: the plain-language performance story ───────────────────
// Turns the qb_pnl_snapshots numbers into a narrative a non-financial reader
// understands: what's working, what needs help, and what we're doing about it.
// Consumed by the monthly email (renderInvestorEmailHtml) + can back an in-app
// summary. See docs/brain/lifecycles/investors-area.md.

interface Snap {
  month: string;
  revenue: number | null;
  netProfit: number | null;
  adjProfit: number | null;
  ads: number | null;
  refunds: number | null;
  chargebacks: number | null;
  fixedOpex: number | null;
}

export interface InvestorPerformance {
  periodLabel: string; // "the 12 months ending June 2026"
  latestMonthLabel: string; // "June 2026"
  ttmRevenue: number;
  revenueYoYPct: number | null; // trailing-12 vs prior-12
  ttmProfit: number; // economic profit (adjusted net income), TTM
  profitDirection: "up" | "down" | "flat" | null;
  adEfficiencyNow: number | null; // sales generated per $1 of ad spend, TTM
  adEfficiencyPrior: number | null;
  refundChargebackPct: number | null; // refunds+chargebacks as % of sales, TTM
  working: string[];
  needsHelp: string[];
  building: string[];
}

const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7))]} ${m.slice(0, 4)}`;
const money = (v: number) => {
  const a = Math.abs(Math.round(v));
  const s = v < 0 ? "-" : "";
  if (a >= 1_000_000) return `${s}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${s}$${Math.round(a / 1000)}k`;
  return `${s}$${a}`;
};
const pct = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`;
const sum = (xs: (number | null)[]) => xs.reduce((a: number, x) => a + (x ?? 0), 0);

/**
 * What we're actively building to move the numbers. Kept as an editable list so
 * the monthly email always says something true and human; update it as the
 * roadmap shifts. (Follow-up: source this from the live specs board so it stays
 * current automatically — tracked in docs/brain/lifecycles/investors-area.md.)
 */
export const INVESTOR_BUILDING: string[] = [
  "A CFO view that pulls the real books straight from QuickBooks, so every number here is the actual number — not a guess.",
  "Smarter customer support that resolves the common questions instantly, keeping more subscribers happy and subscribed.",
  "Tighter control over refunds, chargebacks and discounts — the quiet costs that add up — so more of every sale reaches the bottom line.",
];

/** Pull the snapshots and compute the performance story. */
export async function buildInvestorPerformance(
  workspaceId: string,
  adminClient?: ReturnType<typeof createAdminClient>,
): Promise<InvestorPerformance | null> {
  const admin = adminClient ?? createAdminClient();
  const { data } = await admin
    .from("qb_pnl_snapshots")
    .select("period_month, total_income, net_income, adjusted_net_income, digital_advertising, refunds, chargebacks, fixed_opex")
    .eq("workspace_id", workspaceId)
    .order("period_month", { ascending: true });
  if (!data || data.length === 0) return null;

  const snaps: Snap[] = data.map((r) => ({
    month: r.period_month as string,
    revenue: r.total_income === null ? null : Number(r.total_income),
    netProfit: r.net_income === null ? null : Number(r.net_income),
    adjProfit: r.adjusted_net_income === null ? null : Number(r.adjusted_net_income),
    ads: r.digital_advertising === null ? null : Number(r.digital_advertising),
    refunds: r.refunds === null ? null : Number(r.refunds),
    chargebacks: r.chargebacks === null ? null : Number(r.chargebacks),
    fixedOpex: r.fixed_opex === null ? null : Number(r.fixed_opex),
  }));

  const last = snaps[snaps.length - 1];
  const ttm = snaps.slice(-12);
  const prior = snaps.length >= 24 ? snaps.slice(-24, -12) : null;

  const ttmRevenue = sum(ttm.map((s) => s.revenue));
  const priorRevenue = prior ? sum(prior.map((s) => s.revenue)) : null;
  const revenueYoYPct = priorRevenue && priorRevenue !== 0 ? (ttmRevenue - priorRevenue) / priorRevenue : null;

  const ttmProfit = sum(ttm.map((s) => s.adjProfit));
  const priorProfit = prior ? sum(prior.map((s) => s.adjProfit)) : null;
  const profitDirection: InvestorPerformance["profitDirection"] =
    priorProfit === null ? null : ttmProfit > priorProfit * 1.03 ? "up" : ttmProfit < priorProfit * 0.97 ? "down" : "flat";

  const ttmAds = sum(ttm.map((s) => s.ads));
  const priorAds = prior ? sum(prior.map((s) => s.ads)) : null;
  const adEfficiencyNow = ttmAds > 0 ? ttmRevenue / ttmAds : null;
  const adEfficiencyPrior = prior && priorAds && priorAds > 0 && priorRevenue ? priorRevenue / priorAds : null;

  const ttmRC = sum(ttm.map((s) => (s.refunds ?? 0) + (s.chargebacks ?? 0)));
  const refundChargebackPct = ttmRevenue > 0 ? ttmRC / ttmRevenue : null;
  const priorRC = prior ? sum(prior.map((s) => (s.refunds ?? 0) + (s.chargebacks ?? 0))) : null;
  const priorRCPct = prior && priorRevenue ? (priorRC ?? 0) / priorRevenue : null;

  const ttmFixed = sum(ttm.map((s) => s.fixedOpex));
  const priorFixed = prior ? sum(prior.map((s) => s.fixedOpex)) : null;

  // ── Turn the deltas into plain-language bullets ──
  const working: string[] = [];
  const needsHelp: string[] = [];

  if (revenueYoYPct !== null) {
    (revenueYoYPct >= 0 ? working : needsHelp).push(
      revenueYoYPct >= 0
        ? `Sales over the last year came to ${money(ttmRevenue)} — ${pct(revenueYoYPct)} versus the year before.`
        : `Sales over the last year were ${money(ttmRevenue)}, down ${pct(Math.abs(revenueYoYPct))} from the year before — the top line needs to re-accelerate.`,
    );
  }
  if (adEfficiencyNow !== null && adEfficiencyPrior !== null) {
    const better = adEfficiencyNow >= adEfficiencyPrior;
    (better ? working : needsHelp).push(
      `Every $1 spent on ads brought in about $${adEfficiencyNow.toFixed(2)} in sales${better ? `, up from $${adEfficiencyPrior.toFixed(2)} a year ago — our advertising is working harder.` : `, down from $${adEfficiencyPrior.toFixed(2)} a year ago — ad dollars are stretching less far.`}`,
    );
  }
  if (profitDirection) {
    (profitDirection !== "down" ? working : needsHelp).push(
      profitDirection === "down"
        ? `Underlying profit for the year was ${money(ttmProfit)}, softer than the prior year — we're watching the cost lines closely.`
        : `Underlying profit for the year was ${money(ttmProfit)}, holding ${profitDirection === "up" ? "and improving" : "steady"}.`,
    );
  }
  if (refundChargebackPct !== null) {
    const improving = priorRCPct !== null && refundChargebackPct < priorRCPct;
    (improving || refundChargebackPct < 0.03 ? working : needsHelp).push(
      `Refunds and chargebacks ran at ${(refundChargebackPct * 100).toFixed(1)}% of sales${priorRCPct !== null ? ` (${improving ? "down" : "up"} from ${(priorRCPct * 100).toFixed(1)}% a year ago)` : ""} — ${improving || refundChargebackPct < 0.03 ? "kept in check." : "a line we want to bring down."}`,
    );
  }
  if (priorFixed !== null && ttmFixed !== 0) {
    const leaner = ttmFixed <= priorFixed;
    (leaner ? working : needsHelp).push(
      leaner
        ? `The fixed cost of running the business held at ${money(ttmFixed)} for the year — steady even as we grew.`
        : `Fixed running costs rose to ${money(ttmFixed)} for the year, up from ${money(priorFixed)} — worth keeping an eye on.`,
    );
  }
  if (working.length === 0) working.push(`Sales over the last year came to ${money(ttmRevenue)}.`);
  if (needsHelp.length === 0) needsHelp.push("Nothing flashing red this month — the focus is on compounding what's already working.");

  return {
    periodLabel: `the 12 months ending ${monthName(last.month)}`,
    latestMonthLabel: monthName(last.month),
    ttmRevenue,
    revenueYoYPct,
    ttmProfit,
    profitDirection,
    adEfficiencyNow,
    adEfficiencyPrior,
    refundChargebackPct,
    working,
    needsHelp,
    building: INVESTOR_BUILDING,
  };
}

// ─── Email HTML (inline styles + tables — email-client safe, light theme) ────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function bulletList(items: string[], dot: string): string {
  return items
    .map(
      (t) =>
        `<tr><td style="vertical-align:top;padding:6px 10px 6px 0;font-size:18px;line-height:1.4;">${dot}</td><td style="padding:6px 0;font-size:15px;line-height:1.55;color:#3f3f46;">${esc(t)}</td></tr>`,
    )
    .join("");
}

/** The monthly investor email. Non-technical, warm, and honest — a picture of
 *  performance with a one-tap secure link to the live charts. */
export function renderInvestorEmailHtml(opts: {
  firstName?: string | null;
  link: string;
  perf: InvestorPerformance;
}): string {
  const { firstName, link, perf } = opts;
  const hi = firstName ? ` ${esc(firstName)}` : "";
  const btn = `<a href="${esc(link)}" style="display:inline-block;background:#1baf7a;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:15px 30px;border-radius:12px;">Open this month&rsquo;s update →</a>`;

  return `
  <div style="background:#f4f4f2;padding:32px 0;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e7e5e0;">
    <div style="padding:28px 32px 8px;">
      <div style="display:inline-block;width:30px;height:30px;border-radius:8px;background:#1baf7a;color:#fff;text-align:center;line-height:30px;font-weight:700;font-size:16px;">S</div>
      <span style="font-size:13px;color:#a1a1aa;margin-left:10px;letter-spacing:0.04em;text-transform:uppercase;">Superfoods · Investor Update</span>
    </div>
    <div style="padding:8px 32px 4px;">
      <h1 style="font-size:24px;line-height:1.25;color:#18181b;margin:16px 0 10px;font-weight:650;">Where Superfoods stands${hi}</h1>
      <p style="font-size:16px;line-height:1.6;color:#3f3f46;margin:0 0 8px;">
        Here&rsquo;s an honest snapshot for ${esc(perf.periodLabel)}. Over that stretch the business did
        <strong>${money(perf.ttmRevenue)}</strong> in sales${perf.revenueYoYPct !== null ? `, <strong>${pct(perf.revenueYoYPct)}</strong> versus the year before` : ""}.
        The full, interactive charts are one tap away — no password to remember.
      </p>
    </div>
    <div style="padding:14px 32px 22px;">${btn}</div>

    <div style="padding:4px 32px 4px;">
      <h2 style="font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:#16a34a;margin:18px 0 4px;">What&rsquo;s working</h2>
      <table style="border-collapse:collapse;width:100%;">${bulletList(perf.working, "▲")}</table>

      <h2 style="font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:#d97706;margin:22px 0 4px;">What needs help</h2>
      <table style="border-collapse:collapse;width:100%;">${bulletList(perf.needsHelp, "◆")}</table>

      <h2 style="font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:#2563eb;margin:22px 0 4px;">What we&rsquo;re doing about it</h2>
      <table style="border-collapse:collapse;width:100%;">${bulletList(perf.building, "→")}</table>
    </div>

    <div style="padding:22px 32px 30px;">
      <div style="border-top:1px solid #eeece7;padding-top:22px;">${btn}</div>
      <p style="font-size:13px;line-height:1.6;color:#a1a1aa;margin:20px 0 0;">
        This link is personal to you — please don&rsquo;t forward it. Private &amp; confidential, prepared for
        Superfoods Company investors and owners. Numbers are drawn from our accounting system for fully-closed months.
      </p>
    </div>
  </div>
  </div>`;
}

/** A short 160-char-friendly SMS with the same secure link. */
export function renderInvestorSms(perf: InvestorPerformance, link: string): string {
  const yoy = perf.revenueYoYPct !== null ? ` (${pct(perf.revenueYoYPct)} YoY)` : "";
  return `Superfoods investor update — ${money(perf.ttmRevenue)} in sales this past year${yoy}. See the full charts: ${link}`;
}
