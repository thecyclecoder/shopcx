"use client";

/**
 * Rewards — the loyalty home. Points hero, redemption widget (tiers + progress),
 * any minted coupons, a fun "how it works" program-details block, and the fine
 * print (points earn on the post-discount product subtotal only — not tax or
 * shipping). Reads /api/portal?route=loyaltyBalance; redeems via loyaltyRedeem.
 */

import { useCallback, useEffect, useState } from "react";

interface Tier { index: number; label: string; points_cost: number; discount_value: number; affordable: boolean; points_needed: number }
interface Coupon { id: string; code: string; discount_value: number; status: string; expires_at: string; tier: string }
interface Balance {
  enabled: boolean;
  points_balance: number;
  lifetime_earned: number;
  dollar_value: number;
  program: { points_per_dollar: number; points_per_dollar_value: number; coupon_expiry_days: number };
  tiers: Tier[];
  unused_coupons: Coupon[];
}

export function RewardsSection({ primaryColor, firstName }: { primaryColor: string; firstName?: string }) {
  const [data, setData] = useState<Balance | null>(null);
  const [loading, setLoading] = useState(true);
  const [redeeming, setRedeeming] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/portal?route=loyaltyBalance", { credentials: "same-origin" });
      const d = res.ok ? await res.json() : null;
      setData(d?.ok && d?.enabled ? (d as Balance) : null);
    } catch { setData(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function redeem(tierIndex: number) {
    if (redeeming != null) return;
    setRedeeming(tierIndex);
    setToast(null);
    try {
      const res = await fetch("/api/portal?route=loyaltyRedeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ tierId: tierIndex }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.error) setToast(d?.message || d?.error || "Couldn't redeem — try again.");
      else { setToast(`🎉 Redeemed! Your code${d.code ? ` ${d.code}` : ""} is ready — apply it to a subscription.`); await load(); }
    } catch { setToast("Something went wrong."); }
    finally { setRedeeming(null); }
  }

  if (loading) {
    return <div className="rounded-2xl border border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500">Loading your rewards…</div>;
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-10 text-center">
        <div className="text-4xl">🎁</div>
        <p className="mt-3 text-base font-semibold text-zinc-800">Rewards aren&apos;t available yet</p>
        <p className="mt-1 text-sm text-zinc-500">Check back soon — points are coming.</p>
      </div>
    );
  }

  const { points_balance, lifetime_earned, dollar_value, program, tiers, unused_coupons } = data;
  const nextTier = tiers.find((t) => !t.affordable);
  const topTier = tiers[tiers.length - 1];
  const progressPct = topTier ? Math.min(100, Math.round((points_balance / topTier.points_cost) * 100)) : 0;

  return (
    <div className="space-y-5">
      {toast && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          {toast}
        </div>
      )}

      {/* Hero */}
      <article
        className="relative overflow-hidden rounded-3xl p-6 text-white shadow-sm sm:p-8"
        style={{ background: `linear-gradient(135deg, ${primaryColor} 0%, ${primaryColor}cc 55%, ${primaryColor}99 100%)` }}
      >
        <div className="absolute -right-8 -top-10 text-[120px] leading-none opacity-15 select-none" aria-hidden>🎁</div>
        <p className="text-sm font-semibold uppercase tracking-widest opacity-90">
          {firstName ? `${firstName}'s rewards` : "Your rewards"}
        </p>
        <div className="mt-2 flex items-end gap-2">
          <span className="text-5xl font-black tabular-nums sm:text-6xl">{points_balance.toLocaleString()}</span>
          <span className="mb-1.5 text-lg font-semibold opacity-90">points</span>
        </div>
        <p className="mt-1 text-sm font-medium opacity-90">
          Worth <strong>${dollar_value.toFixed(2)}</strong> toward your next order
          {lifetime_earned > 0 && <> · {lifetime_earned.toLocaleString()} earned all-time</>}
        </p>

        {nextTier && nextTier.points_needed > 0 && (
          <div className="mt-5">
            <div className="flex items-center justify-between text-xs font-semibold opacity-90">
              <span>{nextTier.points_needed.toLocaleString()} pts to {nextTier.label}</span>
              <span>{progressPct}%</span>
            </div>
            <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/25">
              <div className="h-full rounded-full bg-white transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}
      </article>

      {/* Minted coupons ready to use */}
      {unused_coupons.length > 0 && (
        <article className="overflow-hidden rounded-2xl border border-amber-200 bg-amber-50">
          <header className="border-b border-amber-200/70 px-5 py-3">
            <h3 className="text-sm font-bold uppercase tracking-wider text-amber-900">Ready to use</h3>
          </header>
          <ul className="divide-y divide-amber-200/60">
            {unused_coupons.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div>
                  <div className="font-mono text-sm font-bold text-amber-900">{c.code}</div>
                  <div className="text-xs text-amber-700">${Math.round(c.discount_value)} off · apply it on a subscription</div>
                </div>
                <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold uppercase text-amber-700">${Math.round(c.discount_value)} off</span>
              </li>
            ))}
          </ul>
        </article>
      )}

      {/* Redeem */}
      <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <header className="border-b border-zinc-100 p-5">
          <h3 className="text-base font-semibold text-zinc-900">Redeem your points</h3>
          <p className="mt-0.5 text-sm text-zinc-500">Turn points into a discount code for your next delivery.</p>
        </header>
        <ul className="divide-y divide-zinc-100">
          {tiers.map((t) => {
            const pct = Math.min(100, Math.round((points_balance / t.points_cost) * 100));
            return (
              <li key={t.index} className="flex items-center gap-4 p-5">
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl text-lg font-black"
                     style={{ background: `${primaryColor}14`, color: primaryColor }}>
                  ${Math.round(t.discount_value)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-zinc-900">{t.label}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">{t.points_cost.toLocaleString()} points</div>
                  {!t.affordable && (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: primaryColor }} />
                    </div>
                  )}
                </div>
                {t.affordable ? (
                  <button
                    type="button"
                    disabled={redeeming != null}
                    onClick={() => redeem(t.index)}
                    className="flex-shrink-0 rounded-lg px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                    style={{ background: primaryColor }}
                  >
                    {redeeming === t.index ? "Redeeming…" : "Redeem"}
                  </button>
                ) : (
                  <span className="flex-shrink-0 text-xs font-medium text-zinc-400">
                    {t.points_needed.toLocaleString()} to go
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </article>

      {/* How it works — program details */}
      <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <header className="border-b border-zinc-100 p-5">
          <h3 className="text-base font-semibold text-zinc-900">How it works</h3>
          <p className="mt-0.5 text-sm text-zinc-500">Earn as you shop, redeem whenever you like.</p>
        </header>
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          <Step emoji="🛒" title={`Earn ${program.points_per_dollar} points`} body="for every $1 you spend on products." />
          <Step emoji="💰" title={`${program.points_per_dollar_value} points = $1`} body="watch your balance add up fast." />
          <Step emoji="🎉" title="Redeem anytime" body={`Codes are good for ${program.coupon_expiry_days} days after you redeem.`} />
        </div>
      </article>

      {/* Fine print */}
      <p className="px-1 text-xs leading-relaxed text-zinc-400">
        Points are earned on the product subtotal <strong>after discounts</strong> (subscribe &amp; save, quantity breaks, and coupons) —
        not on tax or shipping. Redeemed discount codes are single-use and expire {program.coupon_expiry_days} days after redemption.
      </p>
    </div>
  );
}

function Step({ emoji, title, body }: { emoji: string; title: string; body: string }) {
  return (
    <div className="rounded-xl bg-zinc-50 p-4">
      <div className="text-2xl" aria-hidden>{emoji}</div>
      <div className="mt-2 text-sm font-semibold text-zinc-900">{title}</div>
      <div className="mt-0.5 text-xs leading-relaxed text-zinc-500">{body}</div>
    </div>
  );
}
