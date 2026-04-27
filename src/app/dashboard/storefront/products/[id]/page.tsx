"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { useParams } from "next/navigation";
import Link from "next/link";

interface Variant {
  id?: string;
  title?: string;
  sku?: string;
  price_cents?: number;
  image_url?: string | null;
  [key: string]: unknown;
}

interface Product {
  id: string;
  workspace_id: string;
  shopify_product_id: string;
  title: string;
  handle: string;
  product_type: string | null;
  vendor: string | null;
  status: "active" | "draft" | "archived";
  tags: string[] | null;
  image_url: string | null;
  description: string | null;
  variants: Variant[] | null;
  rating: number | null;
  rating_count: number | null;
  inventory_updated_at: string | null;
  target_customer: string | null;
  certifications: string[] | null;
  intelligence_status: string | null;
  is_bestseller: boolean;
  featured_widget_article_ids: string[] | null;
  header_text: string | null;
  header_text_color: string | null;
  header_text_weight: string | null;
  created_at: string;
  updated_at: string;
}

function formatPrice(cents?: number): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

export default function StorefrontProductDetailPage() {
  const workspace = useWorkspace();
  const { id: productId } = useParams<{ id: string }>();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/products/${productId}`);
    if (res.ok) {
      const data = await res.json();
      setProduct(data.product as Product);
    } else {
      setError("Product not found.");
    }
    setLoading(false);
  }, [workspace.id, productId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6">
        <p className="text-sm text-zinc-400">Loading product...</p>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6">
        <p className="text-sm text-red-500">{error || "Product not found."}</p>
      </div>
    );
  }

  const variants = product.variants || [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <Link
        href="/dashboard/storefront/products"
        className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700"
      >
        &larr; Back to products
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {product.image_url ? (
            <img src={product.image_url} alt="" className="h-20 w-20 rounded-lg object-cover" />
          ) : (
            <div className="h-20 w-20 rounded-lg bg-zinc-100 dark:bg-zinc-800" />
          )}
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{product.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>{product.handle}</span>
              <span>·</span>
              <StatusPill status={product.status} />
              {product.vendor && (
                <>
                  <span>·</span>
                  <span>{product.vendor}</span>
                </>
              )}
              {product.product_type && (
                <>
                  <span>·</span>
                  <span>{product.product_type}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PurgeCacheButton workspaceId={workspace.id} productId={product.id} />
          <Link
            href={`/dashboard/products/${product.id}/intelligence`}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
          >
            Product Intelligence Engine &rarr;
          </Link>
        </div>
      </div>

      <BestsellerToggle product={product} workspaceId={workspace.id} onUpdate={(p) => setProduct(p)} />

      <HeaderSettingsCard product={product} workspaceId={workspace.id} onUpdate={(p) => setProduct(p)} />

      <FeaturedArticlesCard product={product} workspaceId={workspace.id} onUpdate={(p) => setProduct(p)} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Identifiers">
          <KV label="Internal ID" value={product.id} mono />
          <KV label="Shopify product ID" value={product.shopify_product_id} mono />
          <KV label="Handle" value={product.handle} mono />
        </Card>

        <Card title="Classification">
          <KV label="Status" value={product.status} />
          <KV label="Type" value={product.product_type || "—"} />
          <KV label="Vendor" value={product.vendor || "—"} />
        </Card>

        <Card title="Timestamps">
          <KV label="Created" value={formatDate(product.created_at)} />
          <KV label="Updated" value={formatDate(product.updated_at)} />
          <KV label="Inventory checked" value={formatDate(product.inventory_updated_at)} />
        </Card>

        <Card title="Ratings" className="lg:col-span-1">
          <KV label="Rating" value={product.rating != null ? product.rating.toFixed(2) : "—"} />
          <KV label="Review count" value={product.rating_count != null ? String(product.rating_count) : "—"} />
        </Card>

        <Card title="Tags" className="lg:col-span-2">
          {(product.tags || []).length === 0 ? (
            <p className="text-xs text-zinc-400">No tags</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {(product.tags || []).map((t, i) => (
                <span
                  key={i}
                  className="rounded bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card title="Intelligence" className="lg:col-span-3">
          <KV label="Intelligence status" value={product.intelligence_status || "none"} />
          <KV label="Target customer" value={product.target_customer || "—"} />
          <KV
            label="Certifications"
            value={
              (product.certifications || []).length === 0
                ? "—"
                : (product.certifications || []).join(", ")
            }
          />
        </Card>

        {product.description && (
          <Card title="Description" className="lg:col-span-3">
            <div className="prose prose-sm max-w-none text-sm text-zinc-700 dark:prose-invert dark:text-zinc-300"
                 dangerouslySetInnerHTML={{ __html: product.description }} />
          </Card>
        )}

        <Card title={`Variants (${variants.length})`} className="lg:col-span-3">
          {variants.length === 0 ? (
            <p className="text-xs text-zinc-400">No variants.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                  <th className="py-2 pr-2">Title</th>
                  <th className="py-2 pr-2">SKU</th>
                  <th className="py-2 pr-2">Price</th>
                  <th className="py-2 pr-2">Variant ID</th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v, i) => (
                  <tr key={v.id || i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                    <td className="py-2 pr-2">
                      <div className="flex items-center gap-2">
                        {v.image_url && (
                          <img src={v.image_url} alt="" className="h-8 w-8 rounded object-cover" />
                        )}
                        <span className="text-sm text-zinc-900 dark:text-zinc-100">{v.title || "Default"}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">{v.sku || "—"}</td>
                    <td className="py-2 pr-2 text-xs text-zinc-600 dark:text-zinc-400">{formatPrice(v.price_cents)}</td>
                    <td className="py-2 pr-2 font-mono text-[10px] text-zinc-400">{v.id || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Image Management" className="lg:col-span-3">
          <ImageManagement workspaceId={workspace.id} productId={product.id} />
        </Card>

        <Card title="Raw variant JSON" className="lg:col-span-3">
          <pre className="max-h-80 overflow-auto rounded bg-zinc-900 p-3 text-[11px] text-zinc-200">
            {JSON.stringify(variants, null, 2)}
          </pre>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function KV({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className={`text-right text-zinc-900 dark:text-zinc-100 ${mono ? "font-mono text-[11px]" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: Product["status"] }) {
  const colors: Record<Product["status"], string> = {
    active: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
    draft: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    archived: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${colors[status]}`}>
      {status}
    </span>
  );
}

// =============================================================================
// Image Management
// =============================================================================

interface MediaItem {
  slot: string;
  url: string | null;
  alt_text: string;
}

function ImageManagement({ workspaceId, productId }: { workspaceId: string; productId: string }) {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/intelligence-overview`);
    if (res.ok) {
      const data = await res.json();
      setMedia(data.media || []);
    }
    setLoaded(true);
  }, [workspaceId, productId]);

  useEffect(() => { load(); }, [load]);

  const slots = useMemo(() => {
    const base = ["hero", "lifestyle_1", "lifestyle_2", "packaging", "ugc_1", "ugc_2", "ugc_3", "ugc_4", "ugc_5", "ugc_6", "comparison"];
    return base;
  }, []);

  const mediaBySlot = useMemo(() => {
    const map = new Map<string, MediaItem>();
    for (const m of media) map.set(m.slot, m);
    return map;
  }, [media]);

  if (!loaded) return <p className="text-xs text-zinc-400">Loading...</p>;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {slots.map((slot) => (
        <MediaSlot
          key={slot}
          slot={slot}
          media={mediaBySlot.get(slot)}
          workspaceId={workspaceId}
          productId={productId}
          onChange={load}
        />
      ))}
    </div>
  );
}

function MediaSlot({
  slot,
  media,
  workspaceId,
  productId,
  onChange,
}: {
  slot: string;
  media: MediaItem | undefined;
  workspaceId: string;
  productId: string;
  onChange: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [altText, setAltText] = useState(media?.alt_text || "");

  const upload = async (file: File) => {
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("alt_text", altText);
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/media/${slot}`, {
      method: "POST",
      body: fd,
    });
    setBusy(false);
    onChange();
  };

  const saveAlt = async () => {
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/media/${slot}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alt_text: altText }),
    });
  };

  const removeImage = async () => {
    if (!confirm("Remove this image?")) return;
    setBusy(true);
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/media/${slot}`, { method: "DELETE" });
    setBusy(false);
    onChange();
  };

  return (
    <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
        {slot.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
      </div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) upload(f);
        }}
        className="flex h-32 cursor-pointer items-center justify-center rounded border border-dashed border-zinc-300 bg-zinc-50 text-xs text-zinc-500 hover:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800"
      >
        {media?.url ? (
          <img src={media.url} alt={media.alt_text || slot} className="h-full w-full rounded object-cover" />
        ) : busy ? (
          <span>Uploading...</span>
        ) : (
          <span>Click or drop to upload</span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
        }}
      />
      <input
        value={altText}
        onChange={(e) => setAltText(e.target.value)}
        onBlur={saveAlt}
        placeholder="Alt text"
        className="mt-2 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      />
      {media?.url && (
        <button onClick={removeImage} className="mt-2 text-[10px] text-red-400 hover:text-red-600">
          Remove image
        </button>
      )}
    </div>
  );
}

function PurgeCacheButton({
  workspaceId,
  productId,
}: {
  workspaceId: string;
  productId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<"ok" | "err" | null>(null);

  async function purge() {
    setBusy(true);
    setFlash(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/revalidate`, { method: "POST" });
    setFlash(res.ok ? "ok" : "err");
    setBusy(false);
    setTimeout(() => setFlash(null), 2500);
  }

  return (
    <button
      type="button"
      onClick={purge}
      disabled={busy}
      title="Force the storefront page for this product to rebuild on next visit"
      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {busy ? "Purging..." : flash === "ok" ? "Purged ✓" : flash === "err" ? "Failed" : "Purge cache"}
    </button>
  );
}

// Workspace fonts and their preloaded weights — must match
// src/app/(storefront)/_lib/fonts.ts so we don't show the merchant a
// weight option that wasn't shipped.
const FONT_WEIGHTS: Record<string, string[]> = {
  montserrat: ["400", "600", "700"],
  inter: ["400", "500", "600", "700"],
  poppins: ["400", "600", "700"],
  lato: ["400", "700"],
  "open-sans": ["400", "500", "600", "700"],
  "work-sans": ["400", "500", "600", "700"],
  "nunito-sans": ["400", "600", "700"],
  playfair: ["400", "600", "700"],
};
const WEIGHT_LABELS: Record<string, string> = {
  "400": "Regular",
  "500": "Medium",
  "600": "Semibold",
  "700": "Bold",
};

function HeaderSettingsCard({
  product,
  workspaceId,
  onUpdate,
}: {
  product: Product;
  workspaceId: string;
  onUpdate: (p: Product) => void;
}) {
  const [text, setText] = useState(product.header_text || "");
  const [color, setColor] = useState(product.header_text_color || "#18181b");
  const [weight, setWeight] = useState(product.header_text_weight || "700");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [fontKey, setFontKey] = useState<string>("montserrat");

  // Load workspace's storefront font so we can offer only loaded weights.
  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/storefront-design`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.font_key) setFontKey(d.font_key); })
      .catch(() => {});
  }, [workspaceId]);

  const availableWeights = FONT_WEIGHTS[fontKey] || ["400", "600", "700"];

  async function save() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        header_text: text.trim() || null,
        header_text_color: color || null,
        header_text_weight: weight || null,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      onUpdate(data.product as Product);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Could not save.");
    }
    setBusy(false);
  }

  return (
    <div className="mb-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3">
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Storefront header</span>
        <p className="mt-0.5 text-xs text-zinc-500">
          Custom wordmark shown in the fixed header on this product&apos;s page. Defaults to product title.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 md:col-span-3">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Header text</span>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={product.title}
            className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Color</span>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-10 cursor-pointer rounded border border-zinc-300 bg-transparent dark:border-zinc-700"
            />
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1.5 font-mono text-xs uppercase dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Weight</span>
          <select
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            {availableWeights.map(w => (
              <option key={w} value={w}>{WEIGHT_LABELS[w] || w} ({w})</option>
            ))}
          </select>
          <span className="text-[10px] text-zinc-400">Only weights preloaded for the storefront font ({fontKey}) are listed.</span>
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Preview</span>
          <div
            className="flex h-9 items-center rounded border border-zinc-200 bg-zinc-50 px-3 dark:border-zinc-700 dark:bg-zinc-800"
            style={{ color, fontWeight: Number(weight), letterSpacing: 0 }}
          >
            {text.trim() || product.title}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
        >
          {busy ? "Saving..." : "Save header"}
        </button>
        {savedFlash && <span className="text-xs text-emerald-600">Saved.</span>}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    </div>
  );
}

function FeaturedArticlesCard({
  product,
  workspaceId,
  onUpdate,
}: {
  product: Product;
  workspaceId: string;
  onUpdate: (p: Product) => void;
}) {
  const [allArticles, setAllArticles] = useState<{ id: string; title: string; published: boolean }[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedIds = product.featured_widget_article_ids || [];
  const selectedSet = new Set(selectedIds);

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/knowledge-base`)
      .then(r => r.json())
      .then((data: { articles?: { id: string; title: string; published: boolean }[] } | { id: string; title: string; published: boolean }[]) => {
        const list = Array.isArray(data) ? data : data?.articles || [];
        setAllArticles(list.filter(a => a.published));
      })
      .catch(() => {});
  }, [workspaceId]);

  async function save(nextIds: string[]) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featured_widget_article_ids: nextIds }),
    });
    if (res.ok) {
      const data = await res.json();
      onUpdate(data.product as Product);
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Could not save.");
    }
    setBusy(false);
  }

  const selectedArticles = selectedIds
    .map(id => allArticles.find(a => a.id === id))
    .filter((a): a is { id: string; title: string; published: boolean } => !!a);

  const searchLower = search.trim().toLowerCase();
  const candidates = searchLower
    ? allArticles.filter(a => !selectedSet.has(a.id) && a.title.toLowerCase().includes(searchLower)).slice(0, 8)
    : [];

  function move(id: string, dir: -1 | 1) {
    const i = selectedIds.indexOf(id);
    if (i < 0) return;
    const next = [...selectedIds];
    const swap = i + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[i], next[swap]] = [next[swap], next[i]];
    save(next);
  }

  return (
    <div className="mb-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2">
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Featured KB articles in widget ({selectedIds.length}/5)
        </span>
        <p className="mt-0.5 text-xs text-zinc-500">
          Up to 5 articles shown first when a customer opens chat from this product&apos;s page. Order is preserved — pick the ones that sell.
        </p>
      </div>

      {selectedArticles.length > 0 && (
        <ul className="mb-3 space-y-1">
          {selectedArticles.map((a, idx) => (
            <li key={a.id} className="flex items-center gap-2 rounded border border-zinc-100 px-2 py-1.5 text-sm dark:border-zinc-800">
              <span className="w-5 text-xs text-zinc-400">{idx + 1}.</span>
              <span className="flex-1 text-zinc-700 dark:text-zinc-300">{a.title}</span>
              <button disabled={busy || idx === 0} onClick={() => move(a.id, -1)} className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30">↑</button>
              <button disabled={busy || idx === selectedArticles.length - 1} onClick={() => move(a.id, 1)} className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30">↓</button>
              <button disabled={busy} onClick={() => save(selectedIds.filter(id => id !== a.id))} className="text-red-400 hover:text-red-600 disabled:opacity-30">✕</button>
            </li>
          ))}
        </ul>
      )}

      {selectedIds.length < 5 && (
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search KB articles to add..."
            className="w-full rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
          {candidates.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-auto rounded border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              {candidates.map(c => (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { save([...selectedIds, c.id]); setSearch(""); }}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}

function BestsellerToggle({
  product,
  workspaceId,
  onUpdate,
}: {
  product: Product;
  workspaceId: string;
  onUpdate: (p: Product) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = !!product.is_bestseller;

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_bestseller: next }),
    });
    if (res.ok) {
      const data = await res.json();
      onUpdate(data.product as Product);
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Could not update.");
    }
    setBusy(false);
  }

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Best Seller</span>
          {checked && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              ACTIVE
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">
          When on, a green &quot;Best Seller!&quot; badge appears on the storefront product page hero image.
        </p>
        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      </div>
      <button
        type="button"
        onClick={() => toggle(!checked)}
        disabled={busy}
        aria-pressed={checked}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
          checked ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
