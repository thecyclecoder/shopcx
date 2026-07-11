import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadReplenishment } from "@/lib/logistics/replenishment-data";

export const metadata = { title: "Replenishment · Logistics" };

// Finished-good QBO item ids we actively track (the manufactured "-F" rollups).
// Marco tracks the movers first; this list grows as more SKUs are onboarded.
const TRACKED = new Set(["136", "137", "298"]); // SL-30, Berry-30, Berry-10

export default function ReplenishmentPage() {
  // Dynamic (cookies + live QuickBooks) — must live inside Suspense under cacheComponents/PPR.
  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Replenishment</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Days-of-cover (burn rate vs on-hand) against measured supplier lead times, plus inbound purchase orders — live from the canonical inventory feed + QuickBooks.
        </p>
      </header>
      <Suspense fallback={<div className="animate-pulse text-sm text-zinc-400">Loading live purchase orders…</div>}>
        <ReplenishmentContent />
      </Suspense>
    </div>
  );
}

async function ReplenishmentContent() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const workspaceId = (await cookies()).get("workspace_id")?.value;
  if (!workspaceId) redirect("/dashboard");
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") redirect("/dashboard");

  let data;
  try {
    data = await loadReplenishment(workspaceId);
  } catch (e) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
        Could not reach QuickBooks: {(e as Error).message}. Check the QBO connection in Settings.
      </div>
    );
  }

  const fmtDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const today = Date.now();
  const daysAgo = (d: string) => Math.round((today - Date.parse(d)) / 86_400_000);
  const leadByItem = new Map(data.leadTimes.map((l) => [l.itemId, l]));

  const fmtNum = (n: number) => Math.round(n).toLocaleString();
  const fmtMo = (m: number | null) => (m == null ? "—" : `${m.toFixed(1)} mo`);
  // Storefront (3PL) is the subscriber-serving channel — the one that protects the highest-margin
  // recurring revenue. Its cover is the primary signal: an OOS here chokes renewals even while
  // Amazon (FBA) stock sits full. Status keys off storefront cover vs the measured lead time.
  const storefrontStatus = (c: (typeof data.cover)[number], leadMonths?: number) => {
    const sf = c.coverStorefrontMonths;
    if (sf != null && c.burnStorefront > 0 && sf <= 0.02) return { label: "Stockout", cls: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300" };
    if (sf != null && leadMonths != null && sf < leadMonths) return { label: "Reorder", cls: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300" };
    if (sf != null && sf < 1) return { label: "Low", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" };
    if (sf == null) return { label: "—", cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" };
    return { label: "OK", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" };
  };

  return (
    <div className="space-y-8">
      {/* Days of cover — the headline reorder signal, split by fulfillment channel */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Days of cover <span className="font-normal normal-case text-zinc-400">— burn vs on-hand by fulfillment channel, trailing {data.burnWindow.months}mo</span></h2>
        {data.cover.length === 0 ? (
          <p className="text-sm text-zinc-400">No cover data for the tracked finished goods.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Finished good</th>
                  <th className="px-4 py-2.5 text-right font-medium" title="Shopify + internal, fulfilled from the 3PL — the subscriber-serving channel">Storefront burn/on-hand</th>
                  <th className="px-4 py-2.5 text-right font-medium">Storefront cover</th>
                  <th className="px-4 py-2.5 text-right font-medium" title="Fulfilled from FBA — Amazon only">Amazon burn/on-hand</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amazon cover</th>
                  <th className="px-4 py-2.5 text-right font-medium">Lead</th>
                  <th className="px-4 py-2.5 font-medium">Storefront status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.cover.map((c) => {
                  const lead = leadByItem.get(c.finishedGoodQbId);
                  const st = storefrontStatus(c, lead?.avgLeadMonths ?? undefined);
                  return (
                    <tr key={c.finishedGoodQbId} className="text-zinc-700 dark:text-zinc-300">
                      <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">{c.name}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(c.burnStorefront)}/mo <span className="text-zinc-400">· {fmtNum(c.onHandStorefront)} oh</span></td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium">{fmtMo(c.coverStorefrontMonths)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-500 dark:text-zinc-400">{fmtNum(c.burnAmazon)}/mo · {fmtNum(c.onHandAmazon)} oh</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-500 dark:text-zinc-400">{fmtMo(c.coverAmazonMonths)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{lead ? `${lead.avgLeadMonths}mo` : "—"}</td>
                      <td className="px-4 py-2.5"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
          <strong className="font-medium text-zinc-500 dark:text-zinc-400">Storefront</strong> (3PL) fulfills Shopify + internal/subscriber orders — the highest-margin recurring channel; <strong className="font-medium text-zinc-500 dark:text-zinc-400">Amazon</strong> (FBA) is a separate, non-fungible pool. Burn over {data.burnWindow.since} → {data.burnWindow.until}, case-pack multipliers applied. Reconciles exact vs Shopify.
        </p>
      </section>

      {/* Inbound POs — the live, crisis-relevant signal */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Inbound purchase orders</h2>
        {data.openPos.length === 0 ? (
          <p className="text-sm text-zinc-400">No open purchase orders.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Item</th>
                  <th className="px-4 py-2.5 font-medium">Vendor</th>
                  <th className="px-4 py-2.5 text-right font-medium">Ordered</th>
                  <th className="px-4 py-2.5 font-medium">PO date</th>
                  <th className="px-4 py-2.5 font-medium">Projected arrival</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.openPos.map((po) => {
                  // Resolved in the data layer: our annotation (confirmed) > QB DueDate > measured-lead estimate.
                  const eta = data.etaByPo[po.poId];
                  const etaLabel: Record<string, string> = { annotation: "", qb_due_date: "", measured_lead: " (est)", none: "" };
                  const etaTone = eta?.status === "delayed" ? "text-red-600 dark:text-red-400" : eta?.source === "measured_lead" ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-700 dark:text-zinc-300";
                  return (
                    <tr key={po.poId + po.itemId} className="text-zinc-700 dark:text-zinc-300">
                      <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">{po.itemName}</td>
                      <td className="px-4 py-2.5">{po.vendor ?? "—"}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{po.orderedQty.toLocaleString()}</td>
                      <td className="px-4 py-2.5">{fmtDate(po.poDate)} <span className="text-zinc-400">· {daysAgo(po.poDate)}d ago</span></td>
                      <td className={`px-4 py-2.5 ${etaTone}`} title={eta?.note ?? undefined}>
                        {eta?.date ? fmtDate(eta.date) + (etaLabel[eta.source] ?? "") : "—"}
                        {eta?.status === "confirmed" && eta.source === "annotation" && <span className="ml-1.5 text-xs text-emerald-600 dark:text-emerald-400">✓ confirmed</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Measured lead times */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Measured lead times <span className="font-normal normal-case text-zinc-400">— PO → receiving Bill (QuickBooks LinkedTxn)</span></h2>
        {data.leadTimes.length === 0 ? (
          <p className="text-sm text-zinc-400">No completed PO→Bill cycles yet in this window.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Finished good</th>
                  <th className="px-4 py-2.5 font-medium">Supplier</th>
                  <th className="px-4 py-2.5 text-right font-medium">Avg lead</th>
                  <th className="px-4 py-2.5 text-right font-medium">Fill rate</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cycles</th>
                  <th className="px-4 py-2.5 font-medium">Last received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.leadTimes.map((l) => (
                  <tr key={l.itemId} className={`text-zinc-700 dark:text-zinc-300 ${TRACKED.has(l.itemId) ? "" : "opacity-70"}`}>
                    <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">{l.itemName}</td>
                    <td className="px-4 py-2.5">{l.vendor ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">{l.avgLeadMonths} mo <span className="text-zinc-400">({l.avgLeadDays}d)</span></td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{l.avgFillRate != null ? `${Math.round(l.avgFillRate * 100)}%` : "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{l.cycles === 1 ? <span className="text-amber-600 dark:text-amber-400" title="Single cycle — average firms up as more POs close">1</span> : l.cycles}</td>
                    <td className="px-4 py-2.5">{fmtDate(l.lastReceivedDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Read live from QuickBooks ({data.poCount} POs · {data.billCount} bills since {data.since}). <span className="text-zinc-500 dark:text-zinc-400">Next: crisis-aware allocation — preserve inventory for true subscribers, availability-as-lever, demand flip-flop forecast.</span>
      </p>
    </div>
  );
}
