"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Product {
  id: string;
  title: string;
  image_url: string | null;
  shopify_product_id: string;
}

export default function NewProductIntelligencePage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [content, setContent] = useState("");
  const [source, setSource] = useState("shopgrowth");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // URL scrape
  const [scrapeUrl, setScrapeUrl] = useState("");
  const [scraping, setScraping] = useState(false);
  const [scrapeResult, setScrapeResult] = useState<{ title: string; content: string } | null>(null);

  const fetchProducts = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/products`);
    if (res.ok) setProducts(await res.json());
  }, [workspace.id]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  const filteredProducts = products.filter(p =>
    !search || p.title.toLowerCase().includes(search.toLowerCase())
  );

  const handleScrape = async () => {
    if (!scrapeUrl) return;
    setScraping(true);
    setScrapeResult(null);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/product-intelligence/scrape-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: scrapeUrl }),
      });
      if (res.ok) {
        const data = await res.json();
        setScrapeResult(data);
      } else {
        const err = await res.json();
        setError(err.error || "Scrape failed");
      }
    } catch {
      setError("Scrape failed");
    }
    setScraping(false);
  };

  const appendScrapeToContent = () => {
    if (!scrapeResult) return;
    const addition = `\n\n---\nSource: ${scrapeUrl}\n\n${scrapeResult.content}`;
    setContent(prev => prev + addition);
    setScrapeResult(null);
    setScrapeUrl("");
  };

  const handleSave = async () => {
    if (!selectedProduct || !content.trim()) {
      setError("Select a product and paste the intelligence content.");
      return;
    }
    setSaving(true);
    setError("");
    const res = await fetch(`/api/workspaces/${workspace.id}/product-intelligence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: selectedProduct.id,
        title: selectedProduct.title,
        content: content.trim(),
        source,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      router.push(`/dashboard/products/${data.id}`);
    } else {
      const err = await res.json();
      setError(err.error || "Failed to save");
    }
    setSaving(false);
  };

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <Link href="/dashboard/products" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700">
        &larr; Back to Products
      </Link>
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-6">Add Product Intelligence</h1>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</div>
      )}

      {/* Step 1: Select Product */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">1. Select Shopify Product</h2>
        {selectedProduct ? (
          <div className="flex items-center gap-3">
            {selectedProduct.image_url && <img src={selectedProduct.image_url} alt="" className="h-10 w-10 rounded-md object-cover" />}
            <div>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{selectedProduct.title}</p>
            </div>
            <button onClick={() => setSelectedProduct(null)} className="ml-auto text-xs text-red-400 hover:text-red-600">Change</button>
          </div>
        ) : (
          <>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search products..."
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 mb-2"
            />
            <div className="max-h-48 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700">
              {filteredProducts.slice(0, 20).map(p => (
                <button
                  key={p.id}
                  onClick={() => { setSelectedProduct(p); setSearch(""); }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  {p.image_url ? (
                    <img src={p.image_url} alt="" className="h-8 w-8 rounded object-cover" />
                  ) : (
                    <div className="h-8 w-8 rounded bg-zinc-200 dark:bg-zinc-700" />
                  )}
                  <span className="text-zinc-900 dark:text-zinc-100">{p.title}</span>
                </button>
              ))}
              {filteredProducts.length === 0 && <p className="px-3 py-4 text-center text-xs text-zinc-400">No products found</p>}
            </div>
          </>
        )}
      </div>

      {/* Step 2: Paste LLM Export */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">2. Paste Product Intelligence</h2>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          >
            <option value="shopgrowth">From ShopGrowth</option>
            <option value="manual">Manual</option>
          </select>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={16}
          placeholder="Paste the ShopGrowth LLM export here, or type product intelligence manually..."
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
        <p className="mt-1 text-xs text-zinc-400">{content.length.toLocaleString()} characters</p>
      </div>

      {/* Step 3: Optional URL Enrichment */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">3. Enrich from URL (optional)</h2>
        <p className="text-xs text-zinc-400 mb-3">Scrape a webpage (product page, blog post, etc.) and append its content to the intelligence.</p>
        <div className="flex gap-2">
          <input
            value={scrapeUrl}
            onChange={(e) => setScrapeUrl(e.target.value)}
            placeholder="https://superfoodscompany.com/products/amazing-coffee"
            className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
          <button
            onClick={handleScrape}
            disabled={scraping || !scrapeUrl}
            className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50"
          >
            {scraping ? "Scraping..." : "Scrape"}
          </button>
        </div>
        {scrapeResult && (
          <div className="mt-3 rounded-md border border-cyan-200 bg-cyan-50 p-3 dark:border-cyan-800 dark:bg-cyan-950">
            <p className="text-xs font-medium text-cyan-700 dark:text-cyan-300 mb-1">{scrapeResult.title}</p>
            <p className="text-xs text-cyan-600 dark:text-cyan-400 line-clamp-3">{scrapeResult.content.slice(0, 300)}...</p>
            <button
              onClick={appendScrapeToContent}
              className="mt-2 rounded bg-cyan-500 px-3 py-1 text-xs font-medium text-white hover:bg-cyan-600"
            >
              Append to Intelligence
            </button>
          </div>
        )}
      </div>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saving || !selectedProduct || !content.trim()}
        className="rounded-md bg-indigo-500 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save Product Intelligence"}
      </button>
    </div>
  );
}
