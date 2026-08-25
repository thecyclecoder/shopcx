"use client";

// Research › Ads — the owner-facing competitor-ad library, filtered by STATIC vs VIDEO and by one of the
// ~6 advertised (hero) products. Reuses the /api/ads/creative-finder API (extended with productId +
// mediaType filters) and the advertised-products dropdown source. The LIST is a clean, clickable grid —
// each card links to the per-ad detail page (`/dashboard/research/ads/[id]`) where the actions live
// ("Generate ad" + "Don't use"), so the list view stays uncluttered. Owner-gated (API 403 + client
// short-circuit).
//
// Hidden-by-default: `do_not_use=true` rows (the CEO/Max-flagged bad imitation bases) are excluded
// server-side and the suppressed count comes back on the `X-Hidden-Count` response header. A
// `Show hidden (N)` toggle in the filter row re-requests with `includeHidden=1`, bringing them
// back with the existing dim + "don't use" badge so a wrong flag is still reversible from the
// detail page.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface Ad {
  id: string;
  advertiser: string | null;
  title: string | null;
  image_url: string | null;
  thumb_url: string | null;
  media_type: string;
  format: string | null;
  framework: string | null;
  hook: string | null;
  mechanism_claim: string | null;
  proof: string | null;
  offer: string | null;
  days_running: number | null;
  seed_kind: string | null;
  product_id: string | null;
  // flag-a-competitor-ad-do-not-use Phase 2 — the CEO's per-AD exclusion flag (skipped by
  // `queryProvenAngles`). Toggled on the detail page; here it only drives the dim + badge.
  do_not_use: boolean;
  do_not_use_reason: string | null;
  do_not_use_by: string | null;
  do_not_use_at: string | null;
}
interface ProductRow {
  id: string;
  title: string | null;
}

export default function ResearchAdsPage() {
  const workspace = useWorkspace();
  const [mediaType, setMediaType] = useState<"static" | "video">("static");
  const [productId, setProductId] = useState<string>("");
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  // Show-hidden toggle for the CEO/Max-flagged `do_not_use=true` rows. OFF by default so the
  // imitation-base picker is clean; ON re-requests with `includeHidden=1` so a wrong flag is
  // still one click away from being reversed on the detail page.
  const [showHidden, setShowHidden] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(0);


  // Product dropdown — the advertised (hero) products only.
  useEffect(() => {
    if (workspace.role !== "owner") return;
    let alive = true;
    void (async () => {
      const res = await fetch(`/api/ads/advertised-products?workspaceId=${workspace.id}`);
      if (alive && res.ok) setProducts((await res.json()) as ProductRow[]);
    })();
    return () => {
      alive = false;
    };
  }, [workspace.id, workspace.role]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ workspaceId: workspace.id, mediaType });
    if (productId) qs.set("productId", productId);
    if (showHidden) qs.set("includeHidden", "1");
    const res = await fetch(`/api/ads/creative-finder?${qs.toString()}`);
    if (res.status === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    if (res.ok) {
      setAds((await res.json()) as Ad[]);
      // Header names are case-insensitive via Headers.get. Only meaningful when the toggle is
      // OFF — the server skips the count when includeHidden is passed and emits "0".
      setHiddenCount(Number(res.headers.get("x-hidden-count") ?? 0));
    }
    setLoading(false);
  }, [workspace.id, mediaType, productId, showHidden]);

  useEffect(() => {
    if (workspace.role !== "owner") return;
    void load();
  }, [load, workspace.role]);

  if (workspace.role !== "owner" || forbidden) {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
        <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Ads</h1>
        <p className="text-sm text-zinc-500">This surface is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Ads</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Competitor ads found in the ad library for our seeded competitors. Click an ad to open it and
        generate one like it.
      </p>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        {/* Static | Video segmented toggle */}
        <div className="inline-flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          {(["static", "video"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMediaType(m)}
              className={`px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                mediaType === m
                  ? "bg-indigo-600 text-white"
                  : "bg-white text-zinc-600 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Product dropdown (hero products only) */}
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

        {/* Show-hidden toggle — only render when there is something to reveal (or it's already
            on, so the user can turn it back off). Keeps the filter row clean on a library with
            no flagged ads. */}
        {hiddenCount > 0 || showHidden ? (
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden ({hiddenCount})
          </label>
        ) : null}

        <span className="text-xs text-zinc-400">
          {loading ? "Loading…" : `${ads.length} ${mediaType} ad${ads.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : ads.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          No {mediaType} competitor ads {productId ? "for this product " : ""}yet.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ads.map((s) => {
            const src = s.thumb_url;
            return (
              <Link
                key={s.id}
                href={`/dashboard/research/ads/${s.id}`}
                className={`group block overflow-hidden rounded-lg border border-zinc-200 bg-white transition-shadow hover:shadow-md hover:ring-1 hover:ring-indigo-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:ring-indigo-700 ${
                  s.do_not_use ? "opacity-50 grayscale" : ""
                }`}
              >
                <div className="relative aspect-square w-full bg-zinc-100 dark:bg-zinc-800">
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt={s.title || s.advertiser || "creative"} className="h-full w-full object-contain" />
                  ) : null}
                  {s.media_type === "video" ? (
                    <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      ▶ video
                    </span>
                  ) : null}
                  {s.do_not_use ? (
                    <span
                      className="absolute right-2 top-2 rounded bg-red-600/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                      title={
                        s.do_not_use_reason
                          ? `Don't use — ${s.do_not_use_reason} (by ${s.do_not_use_by ?? "?"})`
                          : "Don't use — flagged"
                      }
                    >
                      don&apos;t use
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-zinc-900 group-hover:text-indigo-700 dark:text-zinc-100 dark:group-hover:text-indigo-300">
                      {s.advertiser || "—"}
                    </span>
                    <span className="shrink-0 text-xs text-zinc-500">{s.days_running ?? "?"}d</span>
                  </div>
                  <div className="flex flex-wrap gap-1 text-xs">
                    {s.format ? <Tag>{s.format}</Tag> : null}
                    {s.framework ? <Tag>{s.framework}</Tag> : null}
                  </div>
                  <Slot k="Hook" v={s.hook} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {children}
    </span>
  );
}

function Slot({ k, v }: { k: string; v: string | null }) {
  if (!v) return null;
  return (
    <p className="text-xs">
      <span className="font-semibold text-zinc-500">{k}: </span>
      <span className="text-zinc-700 dark:text-zinc-300">{v}</span>
    </p>
  );
}
