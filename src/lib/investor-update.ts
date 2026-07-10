import { createAdminClient } from "@/lib/supabase/admin";

// ─── Investor update: the plain-language performance story ───────────────────
// Turns the qb_pnl_snapshots numbers into a narrative a non-financial reader
// understands: last month at a glance (each metric vs this year's average + high),
// what's working, what needs help, and what we're doing about it. Everything is
// framed on the PRIMARY WINDOW — the current calendar year if it has ≥6 closed
// months, otherwise the trailing 6 months (early in a year YTD is too thin).
// Consumed by the monthly email (renderInvestorEmailHtml) + SMS. See
// docs/brain/lifecycles/investors-area.md.

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

export interface FocalLine {
  label: string;
  sentence: string; // "came in at $46k last month, below the $80k monthly average this year, …"
}

export interface InvestorPerformance {
  periodLabel: string; // "2026 so far (through June)" | "the 6 months ending June 2026"
  latestMonthLabel: string; // "June 2026"
  primaryLabel: string; // "so far this year" | "over the last 6 months"
  comparisonLabel: string; // "the same period a year earlier" | "the prior 6 months"
  primaryRevenue: number; // sales over the primary window
  primaryYoYPct: number | null; // vs the comparable prior window
  focal: FocalLine[]; // the latest closed month, each metric contextualized
  working: string[];
  needsHelp: string[];
  building: string[];
}

const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7))]} ${m.slice(0, 4)}`;
const yearOf = (m: string) => Number(m.slice(0, 4));
const monthNum = (m: string) => Number(m.slice(5, 7));
const money = (v: number) => {
  const a = Math.abs(Math.round(v));
  const s = v < 0 ? "-" : "";
  if (a >= 1_000_000) return `${s}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${s}$${Math.round(a / 1000)}k`;
  return `${s}$${a}`;
};
const pct = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`;
const sum = (xs: (number | null)[]) => xs.reduce((a: number, x) => a + (x ?? 0), 0);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
  const curYear = Math.max(...snaps.map((s) => yearOf(s.month)));
  const ytd = snaps.filter((s) => yearOf(s.month) === curYear);

  // Primary window: this year if it has ≥6 closed months, else the trailing 6.
  let primary: Snap[];
  let prior: Snap[];
  let primaryLabel: string;
  let comparisonLabel: string;
  let periodLabel: string;
  if (ytd.length >= 6) {
    primary = ytd;
    const maxMo = Math.max(...ytd.map((s) => monthNum(s.month)));
    prior = snaps.filter((s) => yearOf(s.month) === curYear - 1 && monthNum(s.month) <= maxMo);
    primaryLabel = "so far this year";
    comparisonLabel = "the same period a year earlier";
    periodLabel = `${curYear} so far (through ${MONTHS[maxMo]})`;
  } else {
    primary = snaps.slice(-6);
    prior = snaps.slice(-12, -6);
    primaryLabel = "over the last 6 months";
    comparisonLabel = "the prior 6 months";
    periodLabel = `the 6 months ending ${monthName(last.month)}`;
  }
  const priorHas = prior.length > 0;
  const multiYear = new Set(primary.map((s) => yearOf(s.month))).size > 1;
  const monthPhrase = (m: string) => MONTHS[monthNum(m)] + (multiYear ? ` ${yearOf(m)}` : "");

  const primaryRevenue = sum(primary.map((s) => s.revenue));
  const priorRevenue = priorHas ? sum(prior.map((s) => s.revenue)) : null;
  const primaryYoYPct = priorRevenue && priorRevenue !== 0 ? (primaryRevenue - priorRevenue) / priorRevenue : null;

  const primProfit = sum(primary.map((s) => s.adjProfit));
  const priorProfit = priorHas ? sum(prior.map((s) => s.adjProfit)) : null;
  const profitDir = priorProfit === null ? null : primProfit > priorProfit * 1.03 ? "up" : primProfit < priorProfit * 0.97 ? "down" : "flat";

  const primAds = sum(primary.map((s) => s.ads));
  const priorAds = priorHas ? sum(prior.map((s) => s.ads)) : null;
  const adEffNow = primAds > 0 ? primaryRevenue / primAds : null;
  const adEffPrior = priorAds && priorAds > 0 && priorRevenue ? priorRevenue / priorAds : null;

  const primRC = sum(primary.map((s) => (s.refunds ?? 0) + (s.chargebacks ?? 0)));
  const rcPct = primaryRevenue > 0 ? primRC / primaryRevenue : null;
  const priorRC = priorHas ? sum(prior.map((s) => (s.refunds ?? 0) + (s.chargebacks ?? 0))) : null;
  const priorRCPct = priorHas && priorRevenue ? (priorRC ?? 0) / priorRevenue : null;

  const primFixed = sum(primary.map((s) => s.fixedOpex));
  const priorFixed = priorHas ? sum(prior.map((s) => s.fixedOpex)) : null;

  // ── Last month at a glance: each metric vs this window's average + high ──
  const focalMetrics: { label: string; get: (s: Snap) => number | null }[] = [
    { label: "Sales", get: (s) => s.revenue },
    { label: "Underlying profit", get: (s) => s.adjProfit },
    { label: "Digital ad spend", get: (s) => s.ads },
    { label: "Fixed running costs", get: (s) => s.fixedOpex },
    { label: "Refunds & chargebacks", get: (s) => (s.refunds ?? 0) + (s.chargebacks ?? 0) },
  ];
  const focal: FocalLine[] = [];
  for (const fm of focalMetrics) {
    const vals = primary.map((s) => ({ m: s.month, v: fm.get(s) })).filter((x): x is { m: string; v: number } => x.v !== null && x.v !== undefined);
    if (vals.length === 0) continue;
    const latest = vals[vals.length - 1];
    const avg = vals.reduce((a, x) => a + x.v, 0) / vals.length;
    const high = vals.reduce((a, x) => (x.v > a.v ? x : a), vals[0]);
    const vsAvg = latest.v < avg * 0.97 ? "below" : latest.v > avg * 1.03 ? "above" : "in line with";
    const isHigh = high.m === latest.m;
    const tail = isHigh
      ? ` — a fresh high ${primaryLabel}`
      : `, and off the ${money(high.v)} high in ${monthPhrase(high.m)}`;
    focal.push({
      label: fm.label,
      sentence: `came in at ${money(latest.v)} last month, ${vsAvg} the ${money(avg)} monthly average ${primaryLabel}${tail}.`,
    });
  }

  // ── What's working / needs help, over the primary window ──
  const working: string[] = [];
  const needsHelp: string[] = [];

  if (primaryYoYPct !== null) {
    (primaryYoYPct >= 0 ? working : needsHelp).push(
      primaryYoYPct >= 0
        ? `Sales ${primaryLabel} came to ${money(primaryRevenue)} — up ${Math.round(primaryYoYPct * 100)}% vs ${comparisonLabel}.`
        : `Sales ${primaryLabel} were ${money(primaryRevenue)}, down ${Math.round(Math.abs(primaryYoYPct) * 100)}% vs ${comparisonLabel} — the top line needs to re-accelerate.`,
    );
  }
  if (adEffNow !== null && adEffPrior !== null) {
    const better = adEffNow >= adEffPrior;
    (better ? working : needsHelp).push(
      `Every $1 spent on ads brought in about $${adEffNow.toFixed(2)} in sales${better ? `, up from $${adEffPrior.toFixed(2)} — our advertising is working harder.` : `, down from $${adEffPrior.toFixed(2)} — ad dollars are stretching less far.`}`,
    );
  }
  if (profitDir) {
    (profitDir !== "down" ? working : needsHelp).push(
      profitDir === "down"
        ? `Underlying profit ${primaryLabel} was ${money(primProfit)}, softer than ${comparisonLabel} — we're watching the cost lines closely.`
        : `Underlying profit ${primaryLabel} was ${money(primProfit)}, holding ${profitDir === "up" ? "and improving" : "steady"}.`,
    );
  }
  if (rcPct !== null) {
    const improving = priorRCPct !== null && rcPct < priorRCPct;
    (improving || rcPct < 0.03 ? working : needsHelp).push(
      `Refunds and chargebacks ran at ${(rcPct * 100).toFixed(1)}% of sales${priorRCPct !== null ? ` (${improving ? "down" : "up"} from ${(priorRCPct * 100).toFixed(1)}%, ${comparisonLabel})` : ""} — ${improving || rcPct < 0.03 ? "kept in check." : "a line we want to bring down."}`,
    );
  }
  if (priorFixed !== null && primFixed !== 0) {
    const leaner = primFixed <= priorFixed;
    (leaner ? working : needsHelp).push(
      leaner
        ? `The fixed cost of running the business was ${money(primFixed)} ${primaryLabel} — spending stayed disciplined.`
        : `Fixed running costs were ${money(primFixed)} ${primaryLabel}, up from ${money(priorFixed)} vs ${comparisonLabel} — worth keeping an eye on.`,
    );
  }
  if (working.length === 0) working.push(`Sales ${primaryLabel} came to ${money(primaryRevenue)}.`);
  if (needsHelp.length === 0) needsHelp.push("Nothing flashing red this month — the focus is on compounding what's already working.");

  return {
    periodLabel,
    latestMonthLabel: monthName(last.month),
    primaryLabel,
    comparisonLabel,
    primaryRevenue,
    primaryYoYPct,
    focal,
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

function focalList(items: FocalLine[]): string {
  return items
    .map(
      (f) =>
        `<tr><td style="padding:7px 0;font-size:15px;line-height:1.55;color:#3f3f46;border-bottom:1px solid #f1efe9;"><strong style="color:#18181b;">${esc(f.label)}</strong> ${esc(f.sentence)}</td></tr>`,
    )
    .join("");
}

/** The monthly investor email. Non-technical, warm, and honest — last month in
 *  focus, then the picture, with a one-tap secure link to the live charts. */
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
        Here&rsquo;s an honest snapshot. ${esc(cap(perf.primaryLabel))}, the business did
        <strong>${money(perf.primaryRevenue)}</strong> in sales${perf.primaryYoYPct !== null ? `, <strong>${pct(perf.primaryYoYPct)}</strong> vs ${esc(perf.comparisonLabel)}` : ""}.
        The full, interactive charts are one tap away — no password to remember.
      </p>
    </div>
    <div style="padding:14px 32px 22px;">${btn}</div>

    <div style="padding:4px 32px 4px;">
      <h2 style="font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:#57565c;margin:8px 0 6px;">${esc(perf.latestMonthLabel)} at a glance</h2>
      <table style="border-collapse:collapse;width:100%;">${focalList(perf.focal)}</table>

      <h2 style="font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:#16a34a;margin:22px 0 4px;">What&rsquo;s working</h2>
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

/** A short SMS with this-year (or last-6-month) sales + the same secure link. */
export function renderInvestorSms(perf: InvestorPerformance, link: string): string {
  const yoy = perf.primaryYoYPct !== null ? ` (${pct(perf.primaryYoYPct)} vs ${perf.comparisonLabel})` : "";
  return `Superfoods investor update — ${money(perf.primaryRevenue)} in sales ${perf.primaryLabel}${yoy}. See the full charts: ${link}`;
}
