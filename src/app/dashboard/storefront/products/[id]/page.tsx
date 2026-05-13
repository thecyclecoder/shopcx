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

interface TableVariant {
  id: string;                        // internal UUID
  shopify_variant_id: string | null;
  sku: string | null;
  title: string | null;
  price_cents: number;
  compare_at_price_cents: number | null;
  image_url: string | null;
  position: number;
  inventory_quantity: number | null;
  available: boolean;
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
  upsell_product_id: string | null;
  upsell_complementarity: { headline?: string; intro?: string; bullets?: string[] } | null;
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
  const [tableVariants, setTableVariants] = useState<TableVariant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [pRes, vRes] = await Promise.all([
      fetch(`/api/workspaces/${workspace.id}/products/${productId}`),
      fetch(`/api/workspaces/${workspace.id}/products/${productId}/variants`),
    ]);
    if (pRes.ok) {
      const data = await pRes.json();
      setProduct(data.product as Product);
    } else {
      setError("Product not found.");
    }
    if (vRes.ok) {
      const data = await vRes.json();
      setTableVariants((data.variants || []) as TableVariant[]);
    }
    setLoading(false);
  }, [workspace.id, productId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6">
        <p className="text-sm text-zinc-400">Loading product...</p>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6">
        <p className="text-sm text-red-500">{error || "Product not found."}</p>
      </div>
    );
  }

  const variants = product.variants || [];

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
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

      <LinkedProductsCard workspaceId={workspace.id} productId={product.id} productTitle={product.title} />

      <UpsellCard product={product} workspaceId={workspace.id} onUpdate={(p) => setProduct(p)} />

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

        <Card title={`Variants (${tableVariants.length})`} className="lg:col-span-3">
          {tableVariants.length === 0 ? (
            <p className="text-xs text-zinc-400">No variants.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                  <th className="py-2 pr-2">Title</th>
                  <th className="py-2 pr-2">SKU</th>
                  <th className="py-2 pr-2">Price</th>
                  <th className="py-2 pr-2">Internal UUID</th>
                  <th className="py-2 pr-2">Shopify ID</th>
                </tr>
              </thead>
              <tbody>
                {tableVariants.map((v) => (
                  <tr key={v.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                    <td className="py-2 pr-2">
                      <div className="flex items-center gap-2">
                        <VariantImageUploader
                          workspaceId={workspace.id}
                          productId={product.id}
                          variantId={v.id}
                          currentUrl={v.image_url}
                          onChange={(url) => {
                            setTableVariants((prev) =>
                              prev.map((row) =>
                                row.id === v.id ? { ...row, image_url: url } : row,
                              ),
                            );
                          }}
                        />
                        <span className="text-sm text-zinc-900 dark:text-zinc-100">{v.title || "Default"}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">{v.sku || "—"}</td>
                    <td className="py-2 pr-2 text-xs text-zinc-600 dark:text-zinc-400">{formatPrice(v.price_cents)}</td>
                    <td className="py-2 pr-2 font-mono text-[10px] text-zinc-500" title={v.id}>{v.id.slice(0, 8)}…</td>
                    <td className="py-2 pr-2 font-mono text-[10px] text-zinc-400">{v.shopify_variant_id || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-[10px] text-zinc-400">
            Source: <span className="font-mono">product_variants</span> table. Internal UUIDs are the source of truth — Shopify IDs are kept for sync only.
          </p>
        </Card>

        <Card title="Image Management" className="lg:col-span-3">
          <ImageManagement workspaceId={workspace.id} productId={product.id} />
        </Card>

        <details className="lg:col-span-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <summary className="cursor-pointer select-none text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
            Legacy variant JSONB blob (mirror — for reference only)
          </summary>
          <pre className="mt-3 max-h-80 overflow-auto rounded bg-zinc-900 p-3 text-[11px] text-zinc-200">
            {JSON.stringify(variants, null, 2)}
          </pre>
        </details>
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

/**
 * Inline thumbnail-sized uploader for a single product_variants row.
 * Click → file picker → POSTs the file to the variant-image endpoint
 * which stores it and writes back the public URL. Shift-click clears
 * the image. Used in the Variants table on the storefront product
 * page so admins can upload the transparent PNG that powers the
 * stacked pack visuals in the storefront price table.
 */
function VariantImageUploader({
  workspaceId,
  productId,
  variantId,
  currentUrl,
  onChange,
}: {
  workspaceId: string;
  productId: string;
  variantId: string;
  currentUrl: string | null;
  onChange: (url: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `/api/workspaces/${workspaceId}/products/${productId}/variants/${variantId}/image`,
        { method: "POST", body: fd },
      );
      if (!res.ok) throw new Error(await res.text());
      const json = (await res.json()) as { image_url: string };
      onChange(json.image_url);
    } catch (err) {
      console.error("variant image upload failed", err);
      alert("Upload failed — try a PNG or JPG.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async () => {
    if (!currentUrl) return;
    if (!confirm("Remove this variant image?")) return;
    setBusy(true);
    try {
      await fetch(
        `/api/workspaces/${workspaceId}/products/${productId}/variants/${variantId}/image`,
        { method: "DELETE" },
      );
      onChange(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/avif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
        }}
      />
      <button
        type="button"
        onClick={(e) => {
          if (e.shiftKey && currentUrl) {
            remove();
            return;
          }
          inputRef.current?.click();
        }}
        disabled={busy}
        title={currentUrl ? "Click to replace · Shift-click to remove" : "Click to upload variant image"}
        className={`flex h-10 w-10 items-center justify-center rounded-md border border-dashed transition-colors ${
          currentUrl
            ? "border-transparent bg-zinc-100 dark:bg-zinc-800"
            : "border-zinc-300 bg-white hover:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
        } ${busy ? "opacity-60" : ""}`}
      >
        {currentUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={currentUrl} alt="" className="h-9 w-9 rounded object-cover" />
        ) : (
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            {busy ? "…" : "Add"}
          </span>
        )}
      </button>
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
  const [ingredients, setIngredients] = useState<Array<{ name: string }>>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/intelligence-overview`);
    if (res.ok) {
      const data = await res.json();
      setMedia(data.media || []);
      setIngredients(data.ingredients || []);
    }
    setLoaded(true);
  }, [workspaceId, productId]);

  useEffect(() => { load(); }, [load]);

  const slots = useMemo(() => {
    const base = ["hero", "lifestyle_1", "lifestyle_2", "packaging", "before", "after", "endorsement_1_avatar", "endorsement_2_avatar", "endorsement_3_avatar", "timeline_1", "timeline_2", "timeline_3", "timeline_4", "timeline_5", "ugc_1", "ugc_2", "ugc_3", "ugc_4", "ugc_5", "ugc_6", "comparison"];
    // Per-product ingredient slots. Slug must match the storefront's
    // IngredientsSection key derivation (lowercase, spaces → _, strip
    // anything that's not a-z0-9_). Without this list the upload UI
    // had no surface for ingredient images, and the storefront fell
    // back to gray squares.
    const ingredientSlots = ingredients
      .map((i) => `ingredient_${i.name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")}`)
      .filter((s) => s !== "ingredient_");
    return [...base, ...ingredientSlots];
  }, [ingredients]);

  const mediaBySlot = useMemo(() => {
    const map = new Map<string, MediaItem>();
    for (const m of media) map.set(m.slot, m);
    return map;
  }, [media]);

  if (!loaded) return <p className="text-xs text-zinc-400">Loading...</p>;

  return (
    <div className="space-y-6">
      {/* Hero is special — supports a gallery (multiple images, thumbnail
          strip on the storefront). Every other slot is single-image. */}
      <HeroGallerySlot workspaceId={workspaceId} productId={productId} onChange={load} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {slots.filter(s => s !== "hero").map((slot) => (
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
    </div>
  );
}

interface GalleryItem {
  id: string;
  display_order: number;
  url: string | null;
  alt_text: string | null;
}

function HeroGallerySlot({
  workspaceId,
  productId,
  onChange,
}: {
  workspaceId: string;
  productId: string;
  onChange: () => void;
}) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/media/hero/gallery`);
    if (res.ok) {
      const data = await res.json();
      setItems(data.items || []);
    }
  }, [workspaceId, productId]);

  useEffect(() => { load(); }, [load]);

  const upload = async (file: File) => {
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    // Append to the end of the gallery
    fd.append("display_order", String(items.length));
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/media/hero`, {
      method: "POST",
      body: fd,
    });
    setBusy(false);
    await load();
    onChange();
  };

  const removeItem = async (id: string) => {
    if (!confirm("Remove this image?")) return;
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/media/hero/gallery?id=${id}`, {
      method: "DELETE",
    });
    await load();
    onChange();
  };

  const move = async (id: string, dir: -1 | 1) => {
    const idx = items.findIndex(it => it.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= items.length) return;
    const next = [...items];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setItems(next); // optimistic
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/media/hero/gallery`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ordered_ids: next.map(i => i.id) }),
    });
    await load();
    onChange();
  };

  return (
    <div className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Hero gallery</div>
          <div className="mt-0.5 text-xs text-zinc-500">First image is the main display. Add more for clickable thumbnails on the storefront.</div>
        </div>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? "Uploading…" : "+ Add image"}
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          if (e.target) e.target.value = "";
        }}
      />

      {items.length === 0 ? (
        <div
          onClick={() => inputRef.current?.click()}
          className="flex h-32 cursor-pointer items-center justify-center rounded border border-dashed border-zinc-300 bg-zinc-50 text-xs text-zinc-500 hover:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800"
        >
          Click to upload the main hero image
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {items.map((item, i) => (
            <div key={item.id} className="relative">
              <div className="relative aspect-square overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-700">
                {item.url && (
                  <img src={item.url} alt={item.alt_text || `Hero ${i + 1}`} className="h-full w-full object-cover" />
                )}
                {i === 0 && (
                  <span className="absolute left-1 top-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    Main
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <div className="flex gap-1">
                  <button
                    onClick={() => move(item.id, -1)}
                    disabled={i === 0}
                    className="rounded border border-zinc-300 px-1.5 text-[10px] text-zinc-600 hover:border-zinc-400 disabled:opacity-30 dark:border-zinc-700"
                    title="Move left"
                  >
                    ←
                  </button>
                  <button
                    onClick={() => move(item.id, 1)}
                    disabled={i === items.length - 1}
                    className="rounded border border-zinc-300 px-1.5 text-[10px] text-zinc-600 hover:border-zinc-400 disabled:opacity-30 dark:border-zinc-700"
                    title="Move right"
                  >
                    →
                  </button>
                </div>
                <button
                  onClick={() => removeItem(item.id)}
                  className="text-[10px] text-rose-500 hover:text-rose-700"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
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

/**
 * Linked Products worksheet. A product can join one link group (e.g.
 * "Coffee Format" linking Instant ↔ K-Cups). On the storefront PDP,
 * a toggle swaps the hero image, servings chip, and CTA between
 * members. Bidirectional — the linked product page sees the same
 * group automatically.
 *
 * Phase 1: link_type is just "format". Future link_types ("size",
 * "flavor") use the same UI.
 */
type LinkMemberRow = {
  id?: string;
  product_id: string;
  value: string;
  display_order: number;
  product_title: string;
  product_handle: string;
  image_url: string | null;
};

type LinkGroupState = {
  id: string | null;
  link_type: string;
  name: string;
  members: LinkMemberRow[];
};

type ProductOption = { id: string; title: string; handle: string; image_url: string | null };

const LINK_TYPE_OPTIONS = [
  { value: "format", label: "Format (e.g. Instant vs K-Cups)" },
];

function LinkedProductsCard({
  workspaceId,
  productId,
  productTitle,
}: {
  workspaceId: string;
  productId: string;
  productTitle: string;
}) {
  const [group, setGroup] = useState<LinkGroupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/link-group`);
    if (res.ok) {
      const data = await res.json();
      setGroup(data.group);
    }
    setLoading(false);
  }, [workspaceId, productId]);

  useEffect(() => { load(); }, [load]);

  const loadProducts = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/products?status=all`);
    if (res.ok) {
      const data = await res.json();
      setProducts((data || []).map((p: ProductOption) => ({
        id: p.id, title: p.title, handle: p.handle, image_url: p.image_url,
      })));
    }
  }, [workspaceId]);

  function startCreate() {
    setGroup({
      id: null,
      link_type: "format",
      name: "",
      members: [{
        product_id: productId,
        value: "",
        display_order: 0,
        product_title: productTitle,
        product_handle: "",
        image_url: null,
      }],
    });
    setEditing(true);
    loadProducts();
  }

  function startEdit() {
    setEditing(true);
    loadProducts();
  }

  function cancel() {
    setEditing(false);
    setError(null);
    load();
  }

  async function save() {
    if (!group) return;
    setError(null);
    if (!group.name.trim()) { setError("Name is required."); return; }
    if (group.members.length < 2) { setError("Add at least one linked product."); return; }
    if (group.members.some(m => !m.value.trim())) { setError("Every product needs a value (e.g. \"Instant\", \"K-Cups\")."); return; }

    setBusy(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/link-group`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        link_type: group.link_type,
        name: group.name,
        members: group.members.map((m, i) => ({
          product_id: m.product_id,
          value: m.value,
          display_order: i,
        })),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "Failed to save.");
      return;
    }
    setEditing(false);
    load();
  }

  async function deleteGroup() {
    if (!confirm("Delete this link group? Both products will stop showing the toggle.")) return;
    setBusy(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/link-group`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "Failed to delete.");
      return;
    }
    setEditing(false);
    setGroup(null);
  }

  function addMember(p: ProductOption) {
    if (!group) return;
    if (group.members.some(m => m.product_id === p.id)) {
      setPickerOpen(false);
      return;
    }
    setGroup({
      ...group,
      members: [...group.members, {
        product_id: p.id,
        value: "",
        display_order: group.members.length,
        product_title: p.title,
        product_handle: p.handle,
        image_url: p.image_url,
      }],
    });
    setPickerOpen(false);
  }

  function removeMember(productIdToRemove: string) {
    if (!group) return;
    if (productIdToRemove === productId) return; // can't remove the current product
    setGroup({ ...group, members: group.members.filter(m => m.product_id !== productIdToRemove) });
  }

  function updateMemberValue(productIdToUpdate: string, value: string) {
    if (!group) return;
    setGroup({
      ...group,
      members: group.members.map(m => m.product_id === productIdToUpdate ? { ...m, value } : m),
    });
  }

  const eligibleProducts = useMemo(() => {
    const taken = new Set((group?.members || []).map(m => m.product_id));
    return products.filter(p => !taken.has(p.id));
  }, [products, group]);

  return (
    <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Linked Products</h3>
        {!loading && !editing && group && (
          <button
            onClick={startEdit}
            className="text-xs font-medium text-emerald-600 hover:text-emerald-700"
          >
            Edit
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-zinc-400">Loading…</p>
      ) : !group && !editing ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Link this product to others (e.g. different formats of the same coffee)
            so the storefront PDP can show a toggle. Pricing stays on each product&apos;s
            own page; only the hero image and servings chip swap inline.
          </p>
          <button
            onClick={startCreate}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
          >
            Create link group
          </button>
        </div>
      ) : group && !editing ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-500">Link type:</span>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{group.link_type}</span>
            <span className="text-zinc-300">·</span>
            <span className="text-zinc-500">Name:</span>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{group.name}</span>
          </div>
          <div className="space-y-1.5">
            {group.members.map((m) => (
              <div key={m.product_id} className="flex items-center gap-3 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                {m.image_url ? (
                  <img src={m.image_url} alt="" className="h-8 w-8 rounded object-cover" />
                ) : (
                  <div className="h-8 w-8 rounded bg-zinc-100 dark:bg-zinc-800" />
                )}
                <span className="flex-1 text-sm text-zinc-900 dark:text-zinc-100">{m.product_title}</span>
                <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {m.value}
                </span>
                {m.product_id === productId && (
                  <span className="text-[10px] uppercase tracking-wider text-emerald-600">This product</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Link type</span>
              <select
                value={group?.link_type || "format"}
                onChange={(e) => setGroup(g => g ? { ...g, link_type: e.target.value } : g)}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                {LINK_TYPE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Name (shown on storefront)</span>
              <input
                type="text"
                value={group?.name || ""}
                onChange={(e) => setGroup(g => g ? { ...g, name: e.target.value } : g)}
                placeholder="Coffee Format"
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
          </div>

          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Members — value is what appears on the toggle pill
            </div>
            <div className="space-y-1.5">
              {(group?.members || []).map((m) => (
                <div key={m.product_id} className="flex items-center gap-3 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                  {m.image_url ? (
                    <img src={m.image_url} alt="" className="h-8 w-8 rounded object-cover" />
                  ) : (
                    <div className="h-8 w-8 rounded bg-zinc-100 dark:bg-zinc-800" />
                  )}
                  <span className="flex-1 text-sm text-zinc-900 dark:text-zinc-100">
                    {m.product_title}
                    {m.product_id === productId && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-emerald-600">This product</span>
                    )}
                  </span>
                  <input
                    type="text"
                    value={m.value}
                    onChange={(e) => updateMemberValue(m.product_id, e.target.value)}
                    placeholder="e.g. Instant"
                    className="w-32 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  {m.product_id !== productId && (
                    <button
                      onClick={() => removeMember(m.product_id)}
                      className="text-zinc-400 hover:text-red-600"
                      aria-label="Remove"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="relative mt-2">
              <button
                onClick={() => setPickerOpen(o => !o)}
                className="rounded-md border border-dashed border-zinc-300 px-3 py-2 text-sm text-zinc-600 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
              >
                + Add product
              </button>
              {pickerOpen && (
                <div className="absolute z-10 mt-1 max-h-72 w-80 overflow-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                  {eligibleProducts.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-zinc-500">No more products to link.</div>
                  ) : (
                    eligibleProducts.map(p => (
                      <button
                        key={p.id}
                        onClick={() => addMember(p)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
                      >
                        {p.image_url ? (
                          <img src={p.image_url} alt="" className="h-6 w-6 rounded object-cover" />
                        ) : (
                          <div className="h-6 w-6 rounded bg-zinc-100 dark:bg-zinc-800" />
                        )}
                        <span className="text-zinc-900 dark:text-zinc-100">{p.title}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={save}
              disabled={busy}
              className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              onClick={cancel}
              disabled={busy}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            {group?.id && (
              <button
                onClick={deleteGroup}
                disabled={busy}
                className="ml-auto text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Delete group
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Upsell partner + AI-generated complementarity copy. Picks ONE other
 * product in the workspace. When set, the storefront PDP renders an
 * UpsellChapter + a BundlePriceTableSection below the primary price
 * table. The complementarity copy is generated by Haiku from both
 * products' ingredients + benefits and is admin-editable.
 */
function UpsellCard({
  product,
  workspaceId,
  onUpdate,
}: {
  product: Product;
  workspaceId: string;
  onUpdate: (p: Product) => void;
}) {
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [upsellId, setUpsellId] = useState<string | null>(product.upsell_product_id);
  const [headline, setHeadline] = useState(product.upsell_complementarity?.headline || "");
  const [intro, setIntro] = useState(product.upsell_complementarity?.intro || "");
  const [bullets, setBullets] = useState<string[]>(product.upsell_complementarity?.bullets || ["", "", ""]);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/products?status=all`)
      .then(r => r.ok ? r.json() : [])
      .then((data: ProductOption[]) => {
        setProducts((data || []).filter(p => p.id !== product.id));
      })
      .catch(() => {});
  }, [workspaceId, product.id]);

  function setBulletAt(idx: number, value: string) {
    setBullets(prev => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  }

  async function generate() {
    if (!upsellId) { setError("Pick an upsell product first."); return; }
    setError(null);
    setGenerating(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${product.id}/generate-complementarity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partner_product_id: upsellId }),
    });
    setGenerating(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "Generate failed.");
      return;
    }
    const data = await res.json();
    setHeadline(data.headline || "");
    setIntro(data.intro || "");
    setBullets((data.bullets || []).slice(0, 4));
  }

  async function save() {
    setError(null);
    setBusy(true);
    const cleanedBullets = bullets.map(b => b.trim()).filter(Boolean);
    const payload = {
      upsell_product_id: upsellId,
      upsell_complementarity: upsellId
        ? {
            headline: headline.trim() || null,
            intro: intro.trim() || null,
            bullets: cleanedBullets,
          }
        : null,
    };
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "Save failed.");
      return;
    }
    const data = await res.json();
    onUpdate(data.product as Product);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  }

  const upsellTitle = products.find(p => p.id === upsellId)?.title || "";

  return (
    <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Bundle Upsell</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Pre-sell a second product on this PDP as a bundle. When set, the storefront shows a complementarity chapter between this product&apos;s chapters and the price tables, plus a 2-card bundle price table (1+1, 2+2) below the primary price table. Bundle uses this product&apos;s pricing rules — Bundle-1 = 2 units (one of each), Bundle-2 = 4 units.
        </p>
      </div>

      <div className="mb-4">
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Upsell product</span>
          <select
            value={upsellId || ""}
            onChange={(e) => setUpsellId(e.target.value || null)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">— None (disabled) —</option>
            {products.map(p => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        </label>
      </div>

      {upsellId && (
        <>
          <div className="mb-3 flex items-center gap-3">
            <button
              type="button"
              onClick={generate}
              disabled={generating || !upsellId}
              className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-60"
            >
              {generating ? "Generating…" : `Generate copy (pair with ${upsellTitle || "selected product"})`}
            </button>
            <span className="text-xs text-zinc-400">Uses Haiku · ingredients + benefits of both products</span>
          </div>

          <div className="grid gap-3">
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Headline</span>
              <input
                type="text"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                placeholder="Better together"
                className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Intro paragraph (30-50 words)</span>
              <textarea
                value={intro}
                onChange={(e) => setIntro(e.target.value)}
                rows={3}
                placeholder="Explain how the partner's ingredients enhance the primary's benefits."
                className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </label>

            <div>
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Bullets</span>
              <div className="space-y-1.5">
                {bullets.map((b, i) => (
                  <input
                    key={i}
                    type="text"
                    value={b}
                    onChange={(e) => setBulletAt(i, e.target.value)}
                    placeholder={`Bullet ${i + 1}`}
                    className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
        >
          {busy ? "Saving..." : "Save bundle upsell"}
        </button>
        {savedFlash && <span className="text-xs text-emerald-600">Saved.</span>}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    </div>
  );
}
