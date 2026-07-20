"use client";

// Research › Ads — the owner-facing competitor-ad library, filtered by STATIC vs VIDEO and by one of the
// ~6 advertised (hero) products. Reuses the /api/ads/creative-finder API (extended with productId +
// mediaType filters) and the advertised-products dropdown source. Read-only browse — the pattern-matrix +
// shortlist workflow stays on Marketing › Ads › Winning statics. Owner-gated (API 403 + client short-circuit).
import { useCallback, useEffect, useState } from "react";
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
  // The product this competitor ad was seeded for — the default target when the owner clicks
  // "Generate ad" on this card (overridable via the panel's product dropdown).
  product_id: string | null;
  // flag-a-competitor-ad-do-not-use Phase 2 — the CEO's per-AD exclusion flag. When true, this
  // ad is skipped by `queryProvenAngles` (Phase 1) so Dahlia never picks a lame long-runner
  // (Magic Mind display-box packshot) over a strong one (Onnit "Lock in when it matters most").
  do_not_use: boolean;
  do_not_use_reason: string | null;
  do_not_use_by: string | null;
  do_not_use_at: string | null;
}
interface ProductRow {
  id: string;
  title: string | null;
}
// Mirrors `AdAudienceTemperature` from the ad-creative-trigger SDK — defined locally so this client
// component doesn't import a server lib.
type AdTemperature = "cold" | "warm" | "hot";

export default function ResearchAdsPage() {
  const workspace = useWorkspace();
  const [mediaType, setMediaType] = useState<"static" | "video">("static");
  const [productId, setProductId] = useState<string>("");
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const proxy = useCallback(
    (u: string | null): string | null =>
      u ? `/api/ads/creative-finder/media?workspaceId=${workspace.id}&u=${encodeURIComponent(u)}` : null,
    [workspace.id],
  );

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
    const res = await fetch(`/api/ads/creative-finder?${qs.toString()}`);
    if (res.status === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    if (res.ok) setAds((await res.json()) as Ad[]);
    setLoading(false);
  }, [workspace.id, mediaType, productId]);

  // flag-a-competitor-ad-do-not-use Phase 2 — flip the per-AD flag through the PATCH on
  // /api/ads/competitors/[id] (under PATCH the id is a skeleton id — verb-scoped by design;
  // see the route file comment). Optimistically updates the card so the CEO sees the dim +
  // badge immediately; rolls back if the server rejects (e.g. 403 for a non-owner, 404 for a
  // stale id) rather than leaving a lie on the screen.
  const [flipping, setFlipping] = useState<Record<string, boolean>>({});
  const toggleDoNotUse = useCallback(
    async (skeletonId: string, next: boolean) => {
      setFlipping((prev) => ({ ...prev, [skeletonId]: true }));
      const prevAds = ads;
      setAds((current) =>
        current.map((a) =>
          a.id === skeletonId
            ? {
                ...a,
                do_not_use: next,
                do_not_use_reason: next ? "ceo_manual" : null,
                do_not_use_by: next ? "ceo" : null,
                do_not_use_at: next ? new Date().toISOString() : null,
              }
            : a,
        ),
      );
      const res = await fetch(`/api/ads/competitors/${skeletonId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, doNotUse: next }),
      });
      if (!res.ok) setAds(prevAds); // rollback — the DB never flipped
      setFlipping((prev) => {
        const { [skeletonId]: _drop, ...rest } = prev;
        return rest;
      });
    },
    [ads, workspace.id],
  );

  // ── "Generate ad" — self-service Dahlia/Max box session per card ────────────────────────────────
  // Owner picks temperature (cold/warm/hot) + a target hero product (defaults to THIS card's product,
  // overridable), and hits Generate. POSTs /api/ads/generate → triggerAdGeneration → the SDK enqueues
  // kind='ad-creative-copy-author' (the ONLY path that runs the 5 psychological treatments + Max
  // copy-QC — never the deterministic node path). No more coming to the CLI to ask for an ad.
  const [genOpen, setGenOpen] = useState<string | null>(null); // skeleton id whose panel is open
  const [genTemp, setGenTemp] = useState<AdTemperature>("cold");
  const [genProduct, setGenProduct] = useState<string>("");
  const [genBusy, setGenBusy] = useState(false);
  const [genResult, setGenResult] = useState<Record<string, string>>({}); // skeletonId → status line

  const openGen = useCallback(
    (ad: Ad) => {
      setGenOpen(ad.id);
      setGenTemp("cold");
      // Default the target to this card's own product when it's a hero product; else the first hero.
      const heroSelf = ad.product_id && products.some((p) => p.id === ad.product_id) ? ad.product_id : "";
      setGenProduct(heroSelf || products[0]?.id || "");
    },
    [products],
  );

  const submitGen = useCallback(
    async (skeletonId: string) => {
      if (!genProduct) return;
      setGenBusy(true);
      const res = await fetch("/api/ads/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, productId: genProduct, temperature: genTemp }),
      });
      const j = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      setGenBusy(false);
      if (res.ok && j.jobId) {
        setGenResult((prev) => ({ ...prev, [skeletonId]: `✓ Launched Dahlia/Max · ${genTemp} · job ${j.jobId!.slice(0, 8)}` }));
        setGenOpen(null);
      } else {
        setGenResult((prev) => ({ ...prev, [skeletonId]: `⚠️ ${j.error ?? "failed"}` }));
      }
    },
    [genProduct, genTemp, workspace.id],
  );

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
        Competitor ads found in the ad library for our seeded competitors, split by static and video.
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
            const src = s.thumb_url ?? proxy(s.image_url);
            const busy = !!flipping[s.id];
            return (
              <div
                key={s.id}
                className={`overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 ${
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
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">{s.advertiser || "—"}</span>
                    <span className="shrink-0 text-xs text-zinc-500">{s.days_running ?? "?"}d</span>
                  </div>
                  <div className="flex flex-wrap gap-1 text-xs">
                    {s.format ? <Tag>{s.format}</Tag> : null}
                    {s.framework ? <Tag>{s.framework}</Tag> : null}
                  </div>
                  <Slot k="Hook" v={s.hook} />
                  <Slot k="Mechanism" v={s.mechanism_claim} />
                  <Slot k="Proof" v={s.proof} />
                  <Slot k="Offer" v={s.offer} />
                  <button
                    type="button"
                    onClick={() => toggleDoNotUse(s.id, !s.do_not_use)}
                    disabled={busy}
                    className={`mt-2 w-full rounded border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                      s.do_not_use
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                        : "border-zinc-200 bg-white text-zinc-700 hover:bg-red-50 hover:text-red-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                    }`}
                    title={
                      s.do_not_use
                        ? "Un-flag this ad — Dahlia can use it as an imitation angle again."
                        : "Flag this ad as 'don't use' — Dahlia will never imitate it (queryProvenAngles skips it)."
                    }
                  >
                    {busy ? "…" : s.do_not_use ? "Use again" : "Don't use"}
                  </button>

                  {/* Generate ad — self-service Dahlia/Max box session */}
                  {genOpen === s.id ? (
                    <div className="mt-2 space-y-2 rounded-md border border-indigo-200 bg-indigo-50/60 p-2 dark:border-indigo-900 dark:bg-indigo-950/40">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
                        Generate ad
                      </div>
                      {/* Temperature */}
                      <div className="inline-flex overflow-hidden rounded border border-zinc-200 dark:border-zinc-700">
                        {(["cold", "warm", "hot"] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setGenTemp(t)}
                            className={`px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
                              genTemp === t
                                ? "bg-indigo-600 text-white"
                                : "bg-white text-zinc-600 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            }`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      {/* Target product (defaults to this card's product) */}
                      <select
                        value={genProduct}
                        onChange={(e) => setGenProduct(e.target.value)}
                        className="w-full rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title || p.id}
                          </option>
                        ))}
                      </select>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={genBusy || !genProduct}
                          onClick={() => submitGen(s.id)}
                          className="flex-1 rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                        >
                          {genBusy ? "Launching…" : "Generate"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setGenOpen(null)}
                          className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openGen(s)}
                      className="mt-2 w-full rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900"
                      title="Launch a Dahlia/Max box session to author a fresh ad for this product (5 psychological treatments + Max copy-QC)."
                    >
                      Generate ad
                    </button>
                  )}
                  {genResult[s.id] ? (
                    <p
                      className={`mt-1 text-[11px] ${
                        genResult[s.id].startsWith("⚠️")
                          ? "text-red-600 dark:text-red-400"
                          : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {genResult[s.id]}
                    </p>
                  ) : null}
                </div>
              </div>
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
