import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadReplenishment } from "@/lib/logistics/replenishment-data";

export const metadata = { title: "Lead times · Logistics" };

// Finished-good QBO item ids we actively track (the manufactured "-F" rollups).
// Marco tracks the movers first; this list grows as more SKUs are onboarded.
const TRACKED = new Set(["136", "137", "298"]); // SL-30, Berry-30, Berry-10

export default function LeadTimesPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Lead times</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Measured supplier lead + fill rate from closed QuickBooks PO→Bill cycles (LinkedTxn). Untracked finished goods are dimmed; a single-cycle average firms up as more POs close.
        </p>
      </header>
      <Suspense fallback={<div className="animate-pulse text-sm text-zinc-400">Loading measured lead times…</div>}>
        <LeadTimesContent />
      </Suspense>
    </div>
  );
}

async function LeadTimesContent() {
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

  return (
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
      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        Lead time is Bill.TxnDate − PO.TxnDate on the QuickBooks LinkedTxn match; fill rate is received ÷ ordered on those cycles. {data.poCount} POs · {data.billCount} bills since {data.since}. Untracked (non-`-F` finished goods) are dimmed.
      </p>
    </section>
  );
}
