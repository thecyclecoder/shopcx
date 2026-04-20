"use client";

import { useCallback, useEffect, useState } from "react";
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
        <Link
          href={`/dashboard/products/${product.id}/intelligence`}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
        >
          Product Intelligence Engine &rarr;
        </Link>
      </div>

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
