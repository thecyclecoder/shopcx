import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadReplenishment } from "@/lib/logistics/replenishment-data";

export const metadata = { title: "Purchase orders · Logistics" };

export default function PurchaseOrdersPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Purchase orders</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Inbound purchase orders with projected arrival — live from QuickBooks. ETA resolves annotation → QB DueDate → measured-lead estimate; annotated arrivals are the confirmed reality.
        </p>
      </header>
      <Suspense fallback={<div className="animate-pulse text-sm text-zinc-400">Loading live purchase orders…</div>}>
        <PurchaseOrdersContent />
      </Suspense>
    </div>
  );
}

async function PurchaseOrdersContent() {
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

  return (
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
      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        {data.poCount} POs · {data.billCount} bills read live from QuickBooks since {data.since}. Annotate an ETA on Replenishment to promote a PO's projected arrival from measured-lead estimate to confirmed.
      </p>
    </section>
  );
}
