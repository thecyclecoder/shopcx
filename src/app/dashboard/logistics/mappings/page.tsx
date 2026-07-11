import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadMappings, type MappingExternalRef } from "@/lib/logistics/mappings-data";

export const metadata = { title: "Mappings · Logistics" };

const SOURCE_LABEL: Record<string, { label: string; cls: string }> = {
  amazon: { label: "Amazon", cls: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300" },
  "3pl": { label: "3PL", cls: "bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300" },
  shopify: { label: "Shopify", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" },
  manual: { label: "Manual", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" },
};

const PRODUCT_CATEGORY_BADGE: Record<string, { label: string; cls: string }> = {
  finished_good: { label: "Finished good", cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300" },
  component: { label: "Component", cls: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300" },
};

const ITEM_TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  bundle: { label: "Bundle", cls: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/40 dark:text-fuchsia-300" },
};

export default function MappingsPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Mappings</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          The qb_* SKU resolver, read-only. Each QuickBooks item, the external SKUs (Amazon ASIN, 3PL, Shopify, manual) that map onto it, and its BOM components.
        </p>
      </header>
      <Suspense fallback={<div className="animate-pulse text-sm text-zinc-400">Loading mappings…</div>}>
        <MappingsContent />
      </Suspense>
    </div>
  );
}

async function MappingsContent() {
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

  const view = await loadMappings(workspaceId, admin);

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {view.counts.qbItems.toLocaleString()} QB items · {view.counts.activeMappings.toLocaleString()} active external mappings · {view.counts.externalSkus.toLocaleString()} cached external SKUs · {view.counts.bomEdges.toLocaleString()} BOM edges. Read-only.
      </p>
      {view.items.length === 0 ? (
        <p className="text-sm text-zinc-400">No QB items yet — connect QuickBooks and run a sync.</p>
      ) : (
        <div className="space-y-3">
          {view.items.map((item) => {
            const productBadge = item.productCategory ? PRODUCT_CATEGORY_BADGE[item.productCategory] : undefined;
            const typeBadge = ITEM_TYPE_BADGE[item.itemType];
            const sources = Object.keys(item.externalRefsBySource).sort();
            return (
              <section key={item.qbId} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">{item.name}</span>
                  {item.sku && <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-mono text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{item.sku}</span>}
                  {productBadge && <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${productBadge.cls}`}>{productBadge.label}</span>}
                  {typeBadge && <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${typeBadge.cls}`}>{typeBadge.label}</span>}
                  {!item.active && <span className="inline-block rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">Inactive</span>}
                  <span className="text-xs text-zinc-400">
                    QBO #{item.quickbooksId}
                    {item.category && <> · {item.category}</>}
                    {item.totalExternalRefs > 0 && <> · {item.totalExternalRefs} external ref{item.totalExternalRefs === 1 ? "" : "s"}</>}
                    {item.bom.length > 0 && <> · {item.bom.length} BOM component{item.bom.length === 1 ? "" : "s"}</>}
                  </span>
                </div>
                <div className="space-y-4 px-4 py-3">
                  {sources.length === 0 && item.bom.length === 0 && (
                    <p className="text-sm text-zinc-400">No external mappings or BOM components.</p>
                  )}
                  {sources.length > 0 && (
                    <div className="space-y-3">
                      {sources.map((source) => {
                        const badge = SOURCE_LABEL[source] ?? { label: source, cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" };
                        const refs = item.externalRefsBySource[source];
                        return (
                          <div key={source}>
                            <div className="mb-1.5 flex items-center gap-2">
                              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
                              <span className="text-xs text-zinc-400">{refs.length} mapping{refs.length === 1 ? "" : "s"}</span>
                            </div>
                            <div className="overflow-x-auto rounded-md border border-zinc-100 dark:border-zinc-800">
                              <table className="w-full text-sm">
                                <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                                  <tr>
                                    <th className="px-3 py-1.5 font-medium">External id</th>
                                    <th className="px-3 py-1.5 font-medium">Title</th>
                                    <th className="px-3 py-1.5 font-medium">Seller SKU</th>
                                    <th className="px-3 py-1.5 text-right font-medium" title="Multi-pack factor: 1 external unit sold burns N finished-good units">Multiplier</th>
                                    <th className="px-3 py-1.5 font-medium">Status</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                                  {refs.map((r: MappingExternalRef) => (
                                    <tr key={`${r.source}::${r.externalId}`} className={`text-zinc-700 dark:text-zinc-300 ${r.active ? "" : "opacity-60"}`}>
                                      <td className="px-3 py-1.5 font-mono text-xs">{r.externalId}</td>
                                      <td className="px-3 py-1.5">{r.title ?? r.label ?? <span className="text-zinc-400">—</span>}</td>
                                      <td className="px-3 py-1.5 font-mono text-xs">{r.sellerSku ?? <span className="text-zinc-400">—</span>}</td>
                                      <td className="px-3 py-1.5 text-right tabular-nums">{r.unitMultiplier === 1 ? <span className="text-zinc-400">1×</span> : <strong>{r.unitMultiplier}×</strong>}</td>
                                      <td className="px-3 py-1.5 text-xs">{r.active ? <span className="text-emerald-600 dark:text-emerald-400">active</span> : <span className="text-zinc-400">inactive</span>}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {item.bom.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">BOM components</div>
                      <div className="overflow-x-auto rounded-md border border-zinc-100 dark:border-zinc-800">
                        <table className="w-full text-sm">
                          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                            <tr>
                              <th className="px-3 py-1.5 font-medium">Component</th>
                              <th className="px-3 py-1.5 font-medium">SKU</th>
                              <th className="px-3 py-1.5 text-right font-medium">Quantity</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                            {item.bom.map((c) => (
                              <tr key={c.componentQbId} className="text-zinc-700 dark:text-zinc-300">
                                <td className="px-3 py-1.5">{c.componentName}</td>
                                <td className="px-3 py-1.5 font-mono text-xs">{c.componentSku ?? <span className="text-zinc-400">—</span>}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{c.quantity}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Read-only view of qb_items × qb_sku_mappings × qb_external_skus × qb_item_bom. External refs are what the burn-rate + inventory-level joins key on; the multi-pack multiplier is applied to sales that hit a channel (e.g. an Amazon 2-pack ASIN burns 2 finished-good units per order).
      </p>
    </div>
  );
}
