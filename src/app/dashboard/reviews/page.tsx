"use client";

import { useState, useEffect, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Review {
  id: string;
  klaviyo_review_id: string | null;
  shopify_product_id: string;
  product_name: string | null;
  reviewer_name: string | null;
  email: string | null;
  rating: number | null;
  title: string | null;
  body: string | null;
  summary: string | null;
  smart_quote: string | null;
  review_type: string;
  status: string;
  featured: boolean;
  verified_purchase: boolean;
  images: string[];
  customer_id: string | null;
  published_at: string | null;
  updated_at: string | null;
  created_at: string;
}

interface Stats {
  total: number;
  published: number;
  unpublished: number;
  pending: number;
  featured: number;
  rejected: number;
}

interface Product {
  shopify_product_id: string;
  title: string;
}

const STATUS_BADGES: Record<string, { label: string; color: string }> = {
  published: { label: "Published", color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  unpublished: { label: "Unpublished", color: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  pending: { label: "Pending", color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" },
  featured: { label: "Featured", color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" },
  rejected: { label: "Rejected", color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
};

const TYPE_BADGES: Record<string, { label: string; color: string }> = {
  review: { label: "Review", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  rating: { label: "Rating", color: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  store: { label: "Site Review", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
  question: { label: "Question", color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400" },
};

function Stars({ rating }: { rating: number | null }) {
  if (!rating) return <span className="text-xs text-zinc-400">No rating</span>;
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <svg key={i} className={`h-4 w-4 ${i < rating ? "text-yellow-400" : "text-zinc-200 dark:text-zinc-700"}`} fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

export default function ReviewsPage() {
  const workspace = useWorkspace();
  const canEdit = ["owner", "admin"].includes(workspace.role);

  const [reviews, setReviews] = useState<Review[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, published: 0, unpublished: 0, pending: 0, featured: 0, rejected: 0 });
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [productFilter, setProductFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [featuredOnly, setFeaturedOnly] = useState(false);
  const [ratingFilter, setRatingFilter] = useState<Set<number>>(new Set());

  // Expanded review
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Action loading
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (typeFilter) params.set("review_type", typeFilter);
    if (productFilter) params.set("product_id", productFilter);
    if (search) params.set("search", search);
    if (featuredOnly) params.set("featured", "true");
    if (ratingFilter.size > 0) params.set("ratings", Array.from(ratingFilter).join(","));

    const res = await fetch(`/api/workspaces/${workspace.id}/reviews?${params}`);
    if (res.ok) {
      const data = await res.json();
      setReviews(data.reviews);
      setStats(data.stats);
    }
    setLoading(false);
  }, [workspace.id, statusFilter, typeFilter, productFilter, search, featuredOnly, ratingFilter]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  // Load products for filter
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/products`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setProducts(data);
        else if (data.products) setProducts(data.products);
      })
      .catch(() => {});
  }, [workspace.id]);

  const handleSync = async () => {
    setSyncing(true);
    setMessage("");
    const res = await fetch(`/api/workspaces/${workspace.id}/sync-reviews`, { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      setMessage(data.message || "Sync started");
      // Poll for completion after a delay
      setTimeout(() => fetchReviews(), 5000);
    } else {
      setMessage("Sync failed");
    }
    setSyncing(false);
  };

  const handleAction = async (reviewId: string, action: "publish" | "reject" | "feature" | "unfeature", extraBody?: Record<string, unknown>) => {
    setActionLoading(reviewId);
    const res = await fetch(`/api/workspaces/${workspace.id}/reviews/${reviewId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extraBody }),
    });
    if (res.ok) {
      await fetchReviews();
    } else {
      const data = await res.json().catch(() => ({}));
      setMessage(data.error || "Action failed");
    }
    setActionLoading(null);
  };

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Reviews</h1>
          <p className="mt-1 text-sm text-zinc-500">Manage product and site reviews synced from Klaviyo.</p>
        </div>
        {canEdit && stats.total < 2000 && (
          <button
            onClick={handleSync}
            disabled={syncing}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync Reviews"}
          </button>
        )}
      </div>

      {message && (
        <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300">
          {message}
        </div>
      )}

      {/* Stats */}
      <div className="mb-6 grid grid-cols-3 gap-3 sm:grid-cols-6">
        {[
          { label: "Total", value: stats.total, color: "text-zinc-900 dark:text-zinc-100" },
          { label: "Published", value: stats.published, color: "text-green-600" },
          { label: "Unpublished", value: stats.unpublished, color: "text-zinc-500" },
          { label: "Pending", value: stats.pending, color: "text-yellow-600" },
          { label: "Featured", value: stats.featured, color: "text-indigo-600" },
          { label: "Rejected", value: stats.rejected, color: "text-red-600" },
        ].map(s => (
          <button
            key={s.label}
            onClick={() => setStatusFilter(s.label === "Total" ? "" : s.label.toLowerCase())}
            className={`rounded-lg border p-3 text-center transition-colors ${
              (s.label === "Total" && !statusFilter) || statusFilter === s.label.toLowerCase()
                ? "border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950"
                : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            }`}
          >
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-zinc-500">{s.label}</p>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-3">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        >
          <option value="">All types</option>
          <option value="review">Product Reviews</option>
          <option value="store">Site Reviews</option>
          <option value="rating">Ratings Only</option>
          <option value="question">Questions</option>
        </select>

        <select
          value={productFilter}
          onChange={(e) => setProductFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        >
          <option value="">All products</option>
          {products.map(p => (
            <option key={p.shopify_product_id} value={p.shopify_product_id}>{p.title}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={featuredOnly}
            onChange={(e) => setFeaturedOnly(e.target.checked)}
            className="rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
          />
          Featured only
        </label>

        {/* Rating filter */}
        <div className="flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-800">
          {[5, 4, 3, 2, 1].map(star => {
            const active = ratingFilter.has(star);
            return (
              <button
                key={star}
                onClick={() => setRatingFilter(prev => {
                  const next = new Set(prev);
                  if (next.has(star)) next.delete(star); else next.add(star);
                  return next;
                })}
                className={`flex items-center gap-0.5 rounded px-1.5 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                    : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                }`}
              >
                <svg className={`h-3.5 w-3.5 ${active ? "text-yellow-400" : "text-zinc-300 dark:text-zinc-600"}`} fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                {star}
              </button>
            );
          })}
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search reviews..."
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
        />
      </div>

      {/* Reviews list */}
      {loading ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading...</div>
      ) : reviews.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-zinc-500">No reviews found.</p>
          {stats.total === 0 && (
            <p className="mt-2 text-sm text-zinc-400">Connect Klaviyo in Settings → Integrations, then click Sync Reviews.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map(review => {
            const isExpanded = expandedId === review.id;
            const statusBadge = STATUS_BADGES[review.status] || STATUS_BADGES.published;
            const typeBadge = TYPE_BADGES[review.review_type] || TYPE_BADGES.review;

            return (
              <div key={review.id} className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                {/* Header row */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : review.id)}
                  className="flex w-full items-center gap-4 px-4 py-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Stars rating={review.rating} />
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge.color}`}>{statusBadge.label}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${typeBadge.color}`}>{typeBadge.label}</span>
                      {review.verified_purchase && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Verified</span>
                      )}
                    </div>
                    <p className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {review.title || review.summary || (review.body ? review.body.slice(0, 80) + "..." : "No content")}
                    </p>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-zinc-500">
                      <span>{review.reviewer_name || "Anonymous"}</span>
                      {review.product_name && <span>on {review.product_name}</span>}
                      {review.published_at && <span>{new Date(review.published_at).toLocaleDateString()}</span>}
                    </div>
                  </div>
                  <svg className={`h-5 w-5 shrink-0 text-zinc-400 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-zinc-100 px-4 py-4 dark:border-zinc-800">
                    {/* Review body */}
                    {review.body && (
                      <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{review.body}</p>
                    )}

                    {/* Smart quote */}
                    {review.smart_quote && (
                      <div className="mt-3 rounded-md border-l-4 border-indigo-300 bg-indigo-50 px-3 py-2 dark:border-indigo-700 dark:bg-indigo-950">
                        <p className="text-xs font-medium text-indigo-600 dark:text-indigo-400">AI Excerpt</p>
                        <p className="mt-0.5 text-sm text-indigo-800 dark:text-indigo-200">&ldquo;{review.smart_quote}&rdquo;</p>
                      </div>
                    )}

                    {/* Images */}
                    {review.images && review.images.length > 0 && (
                      <div className="mt-3 flex gap-2">
                        {review.images.map((img, i) => (
                          <a key={i} href={img} target="_blank" rel="noopener noreferrer">
                            <img src={img} alt="" className="h-16 w-16 rounded-md object-cover border border-zinc-200 dark:border-zinc-700" />
                          </a>
                        ))}
                      </div>
                    )}

                    {/* Metadata */}
                    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
                      {review.email && <span>Email: {review.email}</span>}
                      {review.customer_id && (
                        <a href={`/dashboard/customers?id=${review.customer_id}`} className="text-indigo-600 hover:underline">View Customer</a>
                      )}
                      {review.shopify_product_id && review.shopify_product_id !== "unknown" && (
                        <span>Product: {review.product_name || review.shopify_product_id}</span>
                      )}
                    </div>

                    {/* Actions */}
                    {canEdit && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {/* Approve: show for pending + rejected */}
                        {(review.status === "pending" || review.status === "rejected") && (
                          <button
                            onClick={() => handleAction(review.id, "publish")}
                            disabled={actionLoading === review.id}
                            className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50"
                          >
                            Approve
                          </button>
                        )}
                        {/* Reject: show for pending + published + featured */}
                        {(review.status === "pending" || review.status === "published" || review.status === "featured") && (
                          <button
                            onClick={() => handleAction(review.id, "reject")}
                            disabled={actionLoading === review.id}
                            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        )}
                        {/* Feature: show for published + pending */}
                        {(review.status === "published" || review.status === "pending") && (
                          <button
                            onClick={() => handleAction(review.id, "feature")}
                            disabled={actionLoading === review.id}
                            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                          >
                            Feature
                          </button>
                        )}
                        {/* Unfeature: show for featured */}
                        {review.status === "featured" && (
                          <button
                            onClick={() => handleAction(review.id, "unfeature")}
                            disabled={actionLoading === review.id}
                            className="rounded-md border border-indigo-300 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-400"
                          >
                            Unfeature
                          </button>
                        )}
                        {/* Type toggle: site ↔ product review */}
                        {(review.review_type === "store" || review.review_type === "review") && (
                          <>
                            <span className="mx-0.5 text-zinc-300 dark:text-zinc-600">|</span>
                            <button
                              onClick={async () => {
                                setActionLoading(review.id);
                                await fetch(`/api/workspaces/${workspace.id}/reviews/${review.id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ review_type: review.review_type === "store" ? "review" : "store" }),
                                });
                                await fetchReviews();
                                setActionLoading(null);
                              }}
                              disabled={actionLoading === review.id}
                              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400"
                            >
                              {review.review_type === "store" ? "→ Product Review" : "→ Site Review"}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
