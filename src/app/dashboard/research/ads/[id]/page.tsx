"use client";

// Research › Ads › [id] — the per-competitor-ad DETAIL page. Opened by clicking an ad on the
// Research › Ads grid. This is where the ACTIONS live (kept off the list view so the grid stays
// clean): "Generate ad like this" (a Dahlia/Max box session that imitates THIS exact ad) + the
// "Don't use" exclusion flag. Owner-gated (the APIs 403 non-owners; the client short-circuits too).
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
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
  seed_keyword: string | null;
  status: string | null;
  product_id: string | null;
  do_not_use: boolean;
  do_not_use_reason: string | null;
  do_not_use_by: string | null;
}
interface ProductRow {
  id: string;
  title: string | null;
}
type AdTemperature = "cold" | "warm" | "hot";

export default function ResearchAdDetailPage() {
  const workspace = useWorkspace();
  const params = useParams<{ id: string }>();
  const skeletonId = params?.id;

  const [ad, setAd] = useState<Ad | null>(null);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const proxy = useCallback(
    (u: string | null): string | null =>
      u ? `/api/ads/creative-finder/media?workspaceId=${workspace.id}&u=${encodeURIComponent(u)}` : null,
    [workspace.id],
  );

  // Load the single ad + the hero-product dropdown source.
  useEffect(() => {
    if (workspace.role !== "owner" || !skeletonId) return;
    let alive = true;
    void (async () => {
      setLoading(true);
      const [adRes, prodRes] = await Promise.all([
        fetch(`/api/ads/creative-finder?workspaceId=${workspace.id}&skeletonId=${skeletonId}`),
        fetch(`/api/ads/advertised-products?workspaceId=${workspace.id}`),
      ]);
      if (!alive) return;
      if (adRes.status === 404) {
        setNotFound(true);
      } else if (adRes.ok) {
        setAd((await adRes.json()) as Ad);
      }
      if (prodRes.ok) setProducts((await prodRes.json()) as ProductRow[]);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [workspace.id, workspace.role, skeletonId]);

  // ── "Generate ad like this" ────────────────────────────────────────────────────────────────────
  const [genTemp, setGenTemp] = useState<AdTemperature>("cold");
  const [genProduct, setGenProduct] = useState<string>(""); // "" ⇒ use the derived default below
  const [genPin, setGenPin] = useState(true); // imitate THIS exact ad — the reason you're on this page
  const [genBusy, setGenBusy] = useState(false);
  const [genResult, setGenResult] = useState<string | null>(null);

  // Default the target product to THIS ad's own product when it's a hero product; else the first hero.
  // Derived in render (not stored in an effect) so the dropdown shows a sensible default once products
  // load without a state write; an explicit pick (`genProduct`) always wins.
  const heroSelf = ad?.product_id && products.some((p) => p.id === ad.product_id) ? ad.product_id : "";
  const defaultProduct = heroSelf || products[0]?.id || "";
  const effectiveProduct = genProduct || defaultProduct;

  const submitGen = useCallback(async () => {
    if (!effectiveProduct || !skeletonId) return;
    setGenBusy(true);
    setGenResult(null);
    const res = await fetch("/api/ads/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        productId: effectiveProduct,
        temperature: genTemp,
        ...(genPin ? { competitorSkeletonId: skeletonId } : {}),
      }),
    });
    const j = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
    setGenBusy(false);
    if (res.ok && j.jobId) {
      const base = genPin ? "imitating this ad" : "shelf-ranked";
      setGenResult(`✓ Launched Dahlia/Max · ${genTemp} · ${base} · job ${j.jobId.slice(0, 8)}`);
    } else {
      setGenResult(`⚠️ ${j.error ?? "failed"}`);
    }
  }, [effectiveProduct, genTemp, genPin, skeletonId, workspace.id]);

  // ── "Don't use" flag ────────────────────────────────────────────────────────────────────────────
  const [flipping, setFlipping] = useState(false);
  const toggleDoNotUse = useCallback(
    async (next: boolean) => {
      if (!ad || !skeletonId) return;
      setFlipping(true);
      const prev = ad;
      setAd({ ...ad, do_not_use: next, do_not_use_reason: next ? "ceo_manual" : null, do_not_use_by: next ? "ceo" : null });
      const res = await fetch(`/api/ads/competitors/${skeletonId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, doNotUse: next }),
      });
      if (!res.ok) setAd(prev); // rollback — the DB never flipped
      setFlipping(false);
    },
    [ad, skeletonId, workspace.id],
  );

  const src = ad ? ad.thumb_url ?? proxy(ad.image_url) : null;

  if (workspace.role !== "owner") {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-500">This surface is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <Link href="/dashboard/research/ads" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
        ← Ads
      </Link>

      {loading ? (
        <p className="mt-6 text-sm text-zinc-500">Loading…</p>
      ) : notFound || !ad ? (
        <div className="mt-6 rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          This ad wasn&apos;t found.
        </div>
      ) : (
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          {/* Left — the creative */}
          <div>
            <div className={`overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800 ${ad.do_not_use ? "opacity-60 grayscale" : ""}`}>
              {src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={src} alt={ad.title || ad.advertiser || "creative"} className="w-full object-contain" />
              ) : (
                <div className="flex aspect-square items-center justify-center text-sm text-zinc-400">no image</div>
              )}
            </div>
          </div>

          {/* Right — info + actions */}
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between gap-2">
                <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{ad.advertiser || "—"}</h1>
                <span className="shrink-0 text-sm text-zinc-500">{ad.days_running ?? "?"}d running</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1 text-xs">
                {ad.format ? <Tag>{ad.format}</Tag> : null}
                {ad.framework ? <Tag>{ad.framework}</Tag> : null}
                {ad.media_type === "video" ? <Tag>▶ video</Tag> : null}
                {ad.do_not_use ? (
                  <span className="rounded-full bg-red-600/90 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
                    don&apos;t use
                  </span>
                ) : null}
              </div>
            </div>

            <div className="space-y-1.5 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <Slot k="Hook" v={ad.hook} />
              <Slot k="Mechanism" v={ad.mechanism_claim} />
              <Slot k="Proof" v={ad.proof} />
              <Slot k="Offer" v={ad.offer} />
              <Slot k="Seed" v={ad.seed_keyword} />
            </div>

            {/* Generate ad like this */}
            <div className="space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900 dark:bg-indigo-950/40">
              <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
                Generate ad like this
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-zinc-500">Audience</span>
                <div className="inline-flex overflow-hidden rounded border border-zinc-200 dark:border-zinc-700">
                  {(["cold", "warm", "hot"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setGenTemp(t)}
                      className={`px-3 py-1 text-xs font-medium capitalize transition-colors ${
                        genTemp === t
                          ? "bg-indigo-600 text-white"
                          : "bg-white text-zinc-600 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-zinc-500">Product</span>
                <select
                  value={effectiveProduct}
                  onChange={(e) => setGenProduct(e.target.value)}
                  className="rounded border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title || p.id}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={genPin}
                  onChange={(e) => setGenPin(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 text-indigo-600 dark:border-zinc-600"
                />
                Imitate this exact ad
                <span
                  className="cursor-help text-zinc-400"
                  title="On: Dahlia reuses THIS ad's layout (composition transfer) and riffs its hook with our product's benefit. Off: she ranks the product's whole competitor shelf and picks the base herself."
                >
                  ⓘ
                </span>
              </label>

              <button
                type="button"
                disabled={genBusy || !effectiveProduct}
                onClick={submitGen}
                className="w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
              >
                {genBusy ? "Launching…" : "Generate ad"}
              </button>
              {genResult ? (
                <p className={`text-xs ${genResult.startsWith("⚠️") ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                  {genResult}
                </p>
              ) : null}
              <p className="text-[11px] text-zinc-400">
                Runs the Dahlia/Max box session — 5 psychological treatments + Max copy-QC.
              </p>
            </div>

            {/* Don't use */}
            <button
              type="button"
              onClick={() => toggleDoNotUse(!ad.do_not_use)}
              disabled={flipping}
              className={`w-full rounded border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                ad.do_not_use
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                  : "border-zinc-200 bg-white text-zinc-700 hover:bg-red-50 hover:text-red-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              }`}
              title={
                ad.do_not_use
                  ? "Un-flag this ad — Dahlia can use it as an imitation angle again."
                  : "Flag this ad as 'don't use' — Dahlia will never imitate it (queryProvenAngles skips it)."
              }
            >
              {flipping ? "…" : ad.do_not_use ? "Use again" : "Don't use as an imitation base"}
            </button>
          </div>
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
    <p className="text-sm">
      <span className="font-semibold text-zinc-500">{k}: </span>
      <span className="text-zinc-700 dark:text-zinc-300">{v}</span>
    </p>
  );
}
