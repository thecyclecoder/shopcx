import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadSupplierView } from "@/lib/logistics/replenishment-data";

export const metadata = { title: "Suppliers · Logistics" };

const KIND_LABEL: Record<string, { label: string; cls: string }> = {
  manufacturer: { label: "Manufacturer", cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300" },
  component: { label: "Component", cls: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300" },
  "3pl": { label: "3PL", cls: "bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300" },
  other: { label: "Other", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" },
};

export default function SuppliersPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Suppliers</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Our supply-chain partners, with lead time + fill rate measured live from QuickBooks PO→Bill cycles. Lead time is who we buy from; fill rate is how close they ship to what we ordered.
        </p>
      </header>
      <Suspense fallback={<div className="animate-pulse text-sm text-zinc-400">Loading suppliers…</div>}>
        <SuppliersContent />
      </Suspense>
    </div>
  );
}

async function SuppliersContent() {
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

  let suppliers;
  try {
    suppliers = await loadSupplierView(workspaceId);
  } catch (e) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
        Could not reach QuickBooks: {(e as Error).message}. Check the QBO connection in Settings.
      </div>
    );
  }

  const fmtLead = (min: number | null, max: number | null) => {
    if (min == null || max == null) return "—";
    const mo = (d: number) => (d / 30.4).toFixed(1);
    return min === max ? `${mo(min)} mo` : `${mo(min)}–${mo(max)} mo`;
  };

  return (
    <div className="space-y-4">
      {suppliers.map((s) => {
        const kind = KIND_LABEL[s.kind] ?? KIND_LABEL.other;
        return (
          <section key={s.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">{s.name}</span>
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${kind.cls}`}>{kind.label}</span>
              <span className="text-xs text-zinc-400">
                Lead {fmtLead(s.measuredLeadDaysMin, s.measuredLeadDaysMax)}
                {s.avgFillRate != null && <> · Fill {Math.round(s.avgFillRate * 100)}%</>}
                {s.minOrderQty != null && <> · MOQ {s.minOrderQty.toLocaleString()}</>}
                {s.openPos.length > 0 && <> · <span className="text-amber-600 dark:text-amber-400">{s.openPos.length} open PO{s.openPos.length > 1 ? "s" : ""}</span></>}
              </span>
            </div>
            <div className="px-4 py-3">
              {s.notes && <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">{s.notes}</p>}
              {s.items.length === 0 ? (
                <p className="text-sm text-zinc-400">No closed PO→Bill cycles measured yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-zinc-400">
                      <tr>
                        <th className="pb-1.5 pr-4 font-medium">Item</th>
                        <th className="pb-1.5 pr-4 text-right font-medium">Avg lead</th>
                        <th className="pb-1.5 pr-4 text-right font-medium">Fill rate</th>
                        <th className="pb-1.5 pr-4 text-right font-medium">Cycles</th>
                        <th className="pb-1.5 font-medium">Last received</th>
                      </tr>
                    </thead>
                    <tbody className="text-zinc-700 dark:text-zinc-300">
                      {s.items.map((it) => (
                        <tr key={it.itemId} className="border-t border-zinc-50 dark:border-zinc-900">
                          <td className="py-1.5 pr-4">{it.itemName}</td>
                          <td className="py-1.5 pr-4 text-right tabular-nums">{it.avgLeadMonths} mo <span className="text-zinc-400">({it.avgLeadDays}d)</span></td>
                          <td className="py-1.5 pr-4 text-right tabular-nums">{it.avgFillRate != null ? `${Math.round(it.avgFillRate * 100)}%` : "—"}</td>
                          <td className="py-1.5 pr-4 text-right tabular-nums">{it.cycles}</td>
                          <td className="py-1.5">{new Date(it.lastReceivedDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        );
      })}
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Lead time + fill rate are measured live from QuickBooks PO→Bill LinkedTxn cycles; supplier kind, MOQ, and notes are stored in ShopCX. Fill rate &lt; 100% means the manufacturer under-produced (they can&apos;t always hit exact quantities).
      </p>
    </div>
  );
}
