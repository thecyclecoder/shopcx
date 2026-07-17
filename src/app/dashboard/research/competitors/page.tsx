"use client";

// Research › Competitors — the owner-facing, read-only competitor set surface
// (docs/brain/dashboard/research__competitors.md). Renders one section per product with the
// product title as the group header, so the set is visually organized around the deliberate
// per-product model. The API is now strict per-product (Phase 2 of
// [[competitor-sdk-chokepoint-and-per-product-cleanup]] — no null-scope fold), so a product
// filter shows ONLY that product's rows. Read-only — discovery + approval stay on the
// Acquisition Research Hub. Owner-gated the same way the sibling acquisition page is: the
// API returns 403 for non-owners, and the client also short-circuits on workspace role so the
// layout doesn't briefly flash.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface CompetitorRow {
  id: string;
  product_id: string | null;
  brand: string;
  domain: string | null;
  pdp_urls: string[] | null;
  category: string | null;
  spend_signal: string | null;
  source: string;
  status: string;
  evidence: string | null;
  search_keyword: string | null;
  runs_ads_for: string | null;
  runs_ads_for_brand: string | null;
  static_count: number;
  video_count: number;
}

interface ProductRow {
  id: string;
  title: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  proposed: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  approved: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

const SOURCE_BADGE: Record<string, string> = {
  manual: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  llm: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  category_sweep: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  whitelisted: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
};

// Approved first, then proposed, then rejected — mirrors the sweep's priority order.
const STATUS_ORDER: Record<string, number> = { approved: 0, proposed: 1, rejected: 2 };

function EvidenceCell({ text }: { text: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <span className="text-zinc-400">—</span>;
  const short = text.length > 120 && !expanded;
  return (
    <div className="max-w-md text-xs text-zinc-600 dark:text-zinc-400">
      <div className={short ? "line-clamp-2" : "whitespace-pre-wrap"}>{text}</div>
      {text.length > 120 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      )}
    </div>
  );
}

export default function ResearchCompetitorsPage() {
  const workspace = useWorkspace();
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [competitors, setCompetitors] = useState<CompetitorRow[]>([]);
  const [productId, setProductId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    // Product list — reuse the same workspace product route the rest of the dashboard uses.
    // status=all so we can select against draft/archived products too (matches how the sibling
    // acquisition hub surfaces its products via loadHubData).
    const productsRes = await fetch(`/api/workspaces/${workspace.id}/products?status=all`);
    if (productsRes.ok) {
      const raw = (await productsRes.json()) as { id: string; title: string | null }[];
      setProducts(raw.map((p) => ({ id: p.id, title: p.title })));
    }

    const qs = new URLSearchParams({ workspaceId: workspace.id });
    if (productId) qs.set("productId", productId);
    const res = await fetch(`/api/ads/competitors?${qs.toString()}`);
    if (res.status === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    if (res.ok) {
      const body = (await res.json()) as { competitors: CompetitorRow[] };
      setCompetitors(body.competitors || []);
    }
    setLoading(false);
  }, [workspace.id, productId]);

  useEffect(() => {
    load();
  }, [load]);

  const productTitleById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of products) m.set(p.id, p.title);
    return m;
  }, [products]);

  const sortedRows = useMemo(() => {
    const rows = [...competitors];
    rows.sort((a, b) => {
      const sa = STATUS_ORDER[a.status] ?? 99;
      const sb = STATUS_ORDER[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      return (a.brand || "").localeCompare(b.brand || "");
    });
    return rows;
  }, [competitors]);

  // Group competitors by product so the surface reflects the deliberate per-product model.
  // Named-product groups render alphabetically by product title; workspace-scoped rows (null
  // product_id — the legacy migrated seeds) render last under a "Workspace-level" heading and
  // will disappear once Phase 3 purges them. When the productId filter is set the API returns
  // strict per-product rows (Phase 2), so this collapses to a single labeled group.
  const WORKSPACE_GROUP_KEY = "__workspace__" as const;
  const groupedByProduct = useMemo(() => {
    const groups = new Map<string, { title: string; rows: CompetitorRow[] }>();
    for (const r of sortedRows) {
      const key = r.product_id ?? WORKSPACE_GROUP_KEY;
      const title = r.product_id
        ? productTitleById.get(r.product_id) || r.product_id
        : "Workspace-level (unscoped)";
      if (!groups.has(key)) groups.set(key, { title, rows: [] });
      groups.get(key)!.rows.push(r);
    }
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === WORKSPACE_GROUP_KEY) return 1;
      if (b[0] === WORKSPACE_GROUP_KEY) return -1;
      return a[1].title.localeCompare(b[1].title);
    });
  }, [sortedRows, productTitleById]);

  if (workspace.role !== "owner" || forbidden) {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
        <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Competitors</h1>
        <p className="text-sm text-zinc-500">This surface is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Competitors</h1>
      <p className="mb-6 text-sm text-zinc-500">
        The competitor set discovered and approved on this workspace. Read-only — discovery and
        approval stay on the Acquisition Research Hub.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-xs uppercase tracking-wide text-zinc-500">Product</label>
        <select
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          className="rounded border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">All products</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || p.id}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-400">
          {loading ? "Loading…" : `${sortedRows.length} row${sortedRows.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : sortedRows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          No competitors match this filter.
        </div>
      ) : (
        <div className="space-y-6">
          {groupedByProduct.map(([key, group]) => (
            <section key={key}>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {group.title}
                  <span className="ml-2 text-xs font-normal text-zinc-500">
                    {group.rows.length} row{group.rows.length === 1 ? "" : "s"}
                  </span>
                </h2>
              </div>
              <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full min-w-[1000px] text-sm">
                  <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                    <tr>
                      <th className="px-4 py-2">Brand</th>
                      <th className="px-4 py-2 text-right" title="Static ads found in the ad library for this competitor">Static</th>
                      <th className="px-4 py-2 text-right" title="Video ads found in the ad library for this competitor">Video</th>
                      <th className="px-4 py-2">Domain</th>
                      <th className="px-4 py-2">Category</th>
                      <th className="px-4 py-2">Source</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2">Spend signal</th>
                      <th className="px-4 py-2">PDPs</th>
                      <th className="px-4 py-2">Evidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {group.rows.map((c) => {
                      const brandDisplay =
                        c.source === "whitelisted" && c.search_keyword
                          ? c.search_keyword
                          : c.brand;
                      return (
                        <tr key={c.id} className="bg-white dark:bg-zinc-950">
                          <td className="px-4 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                            <div>{brandDisplay}</div>
                            {c.source === "whitelisted" && c.runs_ads_for_brand && (
                              <div className="mt-0.5 text-xs font-normal text-zinc-500">
                                runs ads for{" "}
                                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                                  {c.runs_ads_for_brand}
                                </span>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            <span
                              className={
                                c.static_count === 0
                                  ? "font-semibold text-red-600 dark:text-red-400"
                                  : "text-zinc-700 dark:text-zinc-300"
                              }
                              title={c.static_count === 0 ? "No static ads found — likely a bad seed (fix search keyword or replace)" : undefined}
                            >
                              {c.static_count}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            <span
                              className={
                                c.video_count === 0
                                  ? "font-semibold text-red-600 dark:text-red-400"
                                  : "text-zinc-700 dark:text-zinc-300"
                              }
                              title={c.video_count === 0 ? "No video ads found — likely a bad seed (fix search keyword or replace)" : undefined}
                            >
                              {c.video_count}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-zinc-500">{c.domain || "—"}</td>
                          <td className="px-4 py-2 text-zinc-500">{c.category || "—"}</td>
                          <td className="px-4 py-2">
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                                SOURCE_BADGE[c.source] || SOURCE_BADGE.manual
                              }`}
                            >
                              {c.source}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                                STATUS_BADGE[c.status] || ""
                              }`}
                            >
                              {c.status}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-zinc-500">{c.spend_signal || "—"}</td>
                          <td className="px-4 py-2 text-zinc-500">
                            {c.pdp_urls?.length ? c.pdp_urls.length : 0}
                          </td>
                          <td className="px-4 py-2">
                            <EvidenceCell text={c.evidence} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
