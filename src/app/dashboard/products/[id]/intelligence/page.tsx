"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { useParams } from "next/navigation";
import Link from "next/link";

type IntelligenceStatus =
  | "none"
  | "ingredients_added"
  | "researching"
  | "research_complete"
  | "analyzing_reviews"
  | "reviews_complete"
  | "benefits_selected"
  | "generating_content"
  | "content_generated"
  | "published";

interface Ingredient {
  id: string;
  name: string;
  dosage_mg: number | null;
  dosage_display: string | null;
  display_order: number;
}

interface ResearchRow {
  id: string;
  ingredient_id: string;
  benefit_headline: string;
  mechanism_explanation: string;
  clinically_studied_benefits: string[];
  dosage_comparison: string | null;
  citations: Array<{ title?: string; authors?: string; journal?: string; year?: number | string; doi?: string; url?: string }>;
  contraindications: string | null;
  ai_confidence: number;
  researched_at: string;
}

interface IngredientWithResearch extends Ingredient {
  research: ResearchRow[];
}

interface ReviewAnalysis {
  top_benefits: Array<{ benefit: string; frequency: number; customer_phrases?: string[]; review_ids?: string[] }>;
  before_after_pain_points: Array<{ before: string; after: string; review_ids?: string[] }>;
  skeptic_conversions: Array<{ summary: string; quote: string; review_id?: string; reviewer_name?: string }>;
  surprise_benefits: Array<{ benefit: string; quote: string; review_id?: string }>;
  most_powerful_phrases: Array<{ phrase: string; context?: string; review_id?: string; reviewer_name?: string }>;
  reviews_analyzed_count: number;
  analyzed_at: string | null;
}

interface BenefitSelection {
  id?: string;
  benefit_name: string;
  role: "lead" | "supporting" | "skip";
  display_order: number;
  science_confirmed: boolean;
  customer_confirmed: boolean;
  customer_phrases?: string[];
  customer_review_ids?: string[];
  ingredient_research_ids?: string[];
  ai_confidence: number | null;
  notes?: string | null;
}

interface BenefitSuggestion {
  benefit_name: string;
  science_confirmed: boolean;
  customer_confirmed: boolean;
  recommendation: "lead" | "supporting" | "skip";
  reason: string;
}

interface SupportMacro {
  title: string;
  body_text: string;
  body_html?: string;
  question_type: string;
}

interface PageContent {
  id: string;
  version: number;
  hero_headline: string | null;
  hero_subheadline: string | null;
  benefit_bar: Array<{ icon_hint?: string; text: string }>;
  mechanism_copy: string | null;
  ingredient_cards: Array<{ name: string; headline: string; body: string; confidence?: number; image_slot?: string }>;
  comparison_table_rows: Array<{ feature: string; us: string; competitor_generic: string }>;
  faq_items: Array<{ question: string; answer: string }>;
  guarantee_copy: string | null;
  fda_disclaimer: string;
  knowledge_base_article: string | null;
  kb_what_it_doesnt_do: string | null;
  support_macros: SupportMacro[];
  status: "draft" | "approved" | "published";
  generated_at: string;
  approved_at: string | null;
  published_at: string | null;
}

interface MediaItem {
  slot: string;
  url: string | null;
  alt_text: string | null;
  storage_path: string | null;
}

interface Overview {
  product: {
    id: string;
    title: string;
    target_customer: string | null;
    certifications: string[] | null;
    intelligence_status: IntelligenceStatus;
    image_url: string | null;
  };
  ingredients: Ingredient[];
  research: { status: "pending" | "partial" | "complete"; ingredients_with_research: IngredientWithResearch[] };
  review_analysis: ReviewAnalysis | null;
  benefit_selections: BenefitSelection[];
  page_content: PageContent | null;
  media: MediaItem[];
}

const STATUS_STAGES: Record<IntelligenceStatus, number> = {
  none: 0,
  ingredients_added: 0,
  researching: 1,
  research_complete: 1,
  analyzing_reviews: 2,
  reviews_complete: 2,
  benefits_selected: 3,
  generating_content: 4,
  content_generated: 4,
  published: 4,
};

const STAGES: { key: "overview" | "ingredients" | "research" | "reviews" | "benefits" | "content" | "seo"; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "ingredients", label: "Ingredients" },
  { key: "research", label: "Research" },
  { key: "reviews", label: "Reviews" },
  { key: "benefits", label: "Benefits" },
  { key: "content", label: "Content" },
  { key: "seo", label: "SEO" },
];

function StatusBadge({ status }: { status: IntelligenceStatus }) {
  const colors: Record<IntelligenceStatus, string> = {
    none: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    ingredients_added: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    researching: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    research_complete: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
    analyzing_reviews: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    reviews_complete: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
    benefits_selected: "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
    generating_content: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    content_generated: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
    published: "bg-emerald-500 text-white",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${colors[status]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.8
      ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
      : value >= 0.5
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
        : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>{pct}% confidence</span>;
}

export default function ProductIntelligenceEnginePage() {
  const workspace = useWorkspace();
  const { id: productId } = useParams<{ id: string }>();

  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "ingredients" | "research" | "reviews" | "benefits" | "content" | "seo">("overview");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/products/${productId}/intelligence-overview`);
    if (res.ok) {
      const d = (await res.json()) as Overview;
      setOverview(d);
    }
    setLoading(false);
  }, [workspace.id, productId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while in a working status
  const workingStatuses = new Set(["researching", "analyzing_reviews", "generating_content"]);
  useEffect(() => {
    if (!overview) return;
    if (!workingStatuses.has(overview.product.intelligence_status)) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview?.product.intelligence_status, load]);

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <p className="text-sm text-zinc-400">Loading intelligence engine...</p>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <p className="text-sm text-red-500">Product not found.</p>
      </div>
    );
  }

  const stage = STATUS_STAGES[overview.product.intelligence_status];

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <Link
        href="/dashboard/products"
        className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700"
      >
        &larr; Back to Products
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {overview.product.image_url ? (
            <img src={overview.product.image_url} alt="" className="h-16 w-16 rounded-lg object-cover" />
          ) : (
            <div className="h-16 w-16 rounded-lg bg-zinc-100 dark:bg-zinc-800" />
          )}
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{overview.product.title}</h1>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-xs text-zinc-500">Product Intelligence Engine</span>
              <StatusBadge status={overview.product.intelligence_status} />
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex gap-1 overflow-x-auto">
          {STAGES.map((s) => {
            const hasIngredients = overview.ingredients.length > 0;
            const hasResearch = overview.research.status !== "pending";
            const hasReviews = !!overview.review_analysis;
            const hasBenefits = overview.benefit_selections.length > 0;
            const disabled =
              (s.key === "research" && !hasIngredients) ||
              (s.key === "benefits" && (!hasResearch || !hasReviews)) ||
              (s.key === "content" && !hasBenefits);

            return (
              <button
                key={s.key}
                onClick={() => !disabled && setActiveTab(s.key)}
                disabled={disabled}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                  activeTab === s.key
                    ? "border-indigo-500 text-indigo-600"
                    : disabled
                      ? "border-transparent text-zinc-300 dark:text-zinc-600 cursor-not-allowed"
                      : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === "overview" && (
        <OverviewStage
          workspaceId={workspace.id}
          productId={productId}
          overview={overview}
          onChange={load}
          saving={saving}
          setSaving={setSaving}
          setError={setError}
        />
      )}
      {activeTab === "ingredients" && (
        <IngredientsStage
          workspaceId={workspace.id}
          productId={productId}
          overview={overview}
          onChange={load}
          saving={saving}
          setSaving={setSaving}
          setError={setError}
        />
      )}
      {activeTab === "research" && (
        <ResearchStage
          workspaceId={workspace.id}
          productId={productId}
          overview={overview}
          onChange={load}
          setError={setError}
        />
      )}
      {activeTab === "reviews" && (
        <ReviewsStage
          workspaceId={workspace.id}
          productId={productId}
          overview={overview}
          onChange={load}
          setError={setError}
        />
      )}
      {activeTab === "benefits" && (
        <BenefitsStage
          workspaceId={workspace.id}
          productId={productId}
          overview={overview}
          onChange={load}
          setError={setError}
        />
      )}
      {activeTab === "content" && (
        <ContentStage
          workspaceId={workspace.id}
          productId={productId}
          overview={overview}
          onChange={load}
          setError={setError}
        />
      )}
      {activeTab === "seo" && (
        <SEOStage
          workspaceId={workspace.id}
          productId={productId}
          setError={setError}
        />
      )}

    </div>
  );
}

// =============================================================================
// Overview: Target Customer & Certifications
// =============================================================================

function TagListEditor({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState("");
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {items.map((c, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {c}
            <button onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-red-500" type="button">×</button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) { onChange([...items, input.trim()]); setInput(""); } }}
          placeholder={placeholder}
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
        <button
          onClick={() => { if (input.trim()) { onChange([...items, input.trim()]); setInput(""); } }}
          className="rounded-md bg-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300"
          type="button"
        >Add</button>
      </div>
    </>
  );
}

function OverviewStage({
  workspaceId,
  productId,
  overview,
  onChange,
  saving,
  setSaving,
  setError,
}: {
  workspaceId: string;
  productId: string;
  overview: Overview;
  onChange: () => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  setError: (e: string | null) => void;
}) {
  const [targetCustomer, setTargetCustomer] = useState(overview.product.target_customer || "");
  const [certifications, setCertifications] = useState<string[]>(overview.product.certifications || []);
  const [allergenFree, setAllergenFree] = useState<string[]>((overview.product as Record<string, unknown>).allergen_free as string[] || []);
  const [awards, setAwards] = useState<string[]>((overview.product as Record<string, unknown>).awards as string[] || []);
  const [suggestedTarget, setSuggestedTarget] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/demographics/summary`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.suggested_target_customer) setSuggestedTarget(data.suggested_target_customer);
      })
      .catch(() => {});
  }, [workspaceId]);

  const saveMeta = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/intelligence`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_customer: targetCustomer, certifications, allergen_free: allergenFree, awards }),
      });
      if (!res.ok) throw new Error("Failed to save");
      onChange();
    } catch (err) {
      setError(String(err));
    }
    setSaving(false);
  };

  return (
    <div className="space-y-6">
      {/* Target Customer */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Target Customer</h2>
        {suggestedTarget && !targetCustomer && (
          <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-800 dark:bg-indigo-950">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-indigo-500">Auto-suggested from your customer data</p>
            <p className="text-sm text-indigo-700 dark:text-indigo-300">{suggestedTarget}</p>
            <button onClick={() => setTargetCustomer(suggestedTarget)} className="mt-2 rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500">Use this</button>
          </div>
        )}
        <input
          value={targetCustomer}
          onChange={(e) => setTargetCustomer(e.target.value)}
          placeholder="e.g. Women 45-65 seeking joint mobility"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
      </div>

      {/* Certifications */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Certifications</h2>
        <p className="mb-3 text-xs text-zinc-500">Trust badges — Non-GMO, 3rd Party Tested, USDA Organic, etc.</p>
        <TagListEditor items={certifications} onChange={setCertifications} placeholder="e.g. Non-GMO, 3rd Party Tested (Enter to add)" />
      </div>

      {/* Allergen-Free */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Allergen-Free Claims</h2>
        <p className="mb-3 text-xs text-zinc-500">What's NOT in the product — removes purchase objections.</p>
        <TagListEditor items={allergenFree} onChange={setAllergenFree} placeholder="e.g. Gluten Free, Dairy Free, Soy Free (Enter to add)" />
      </div>

      {/* Awards & Press */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Awards & Press</h2>
        <p className="mb-3 text-xs text-zinc-500">Social proof for the hero section — awards, press mentions, rankings.</p>
        <TagListEditor items={awards} onChange={setAwards} placeholder='e.g. Best Tasting Superfood Coffee — Gourmet Magazine 2025 (Enter to add)' />
      </div>

      <button
        onClick={saveMeta}
        disabled={saving}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {saving ? "Saving..." : "Save All"}
      </button>
    </div>
  );
}

// =============================================================================
// Stage 1: Ingredients
// =============================================================================

function IngredientsStage({
  workspaceId,
  productId,
  overview,
  onChange,
  saving,
  setSaving,
  setError,
}: {
  workspaceId: string;
  productId: string;
  overview: Overview;
  onChange: () => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  setError: (v: string | null) => void;
}) {
  const [newIng, setNewIng] = useState({ name: "", dosage: "" });
  const [busy, setBusy] = useState(false);

  const addIngredient = async () => {
    if (!newIng.name.trim()) return;
    setBusy(true);
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/ingredients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newIng.name.trim(),
        dosage_display: newIng.dosage.trim() || null,
      }),
    });
    setNewIng({ name: "", dosage: "" });
    setBusy(false);
    onChange();
  };

  const updateIngredient = async (id: string, patch: Partial<Ingredient>) => {
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/ingredients/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    onChange();
  };

  const deleteIngredient = async (id: string) => {
    if (!confirm("Delete this ingredient? Any research will be removed.")) return;
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/ingredients/${id}`, {
      method: "DELETE",
    });
    onChange();
  };

  const startResearch = async () => {
    if (overview.ingredients.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await Promise.all([
        fetch(`/api/workspaces/${workspaceId}/products/${productId}/research`, { method: "POST" }),
        fetch(`/api/workspaces/${workspaceId}/products/${productId}/analyze-reviews`, { method: "POST" }),
      ]);
    } catch (err) {
      setError(String(err));
    }
    setBusy(false);
    onChange();
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Ingredients ({overview.ingredients.length})
        </h2>
        {overview.ingredients.length === 0 ? (
          <p className="mb-3 text-xs text-zinc-500">No ingredients yet. Add them below.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                <th className="py-2">Name</th>
                <th className="py-2">Dosage</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {overview.ingredients.map((ing) => (
                <IngredientRow
                  key={ing.id}
                  ingredient={ing}
                  onUpdate={(patch) => updateIngredient(ing.id, patch)}
                  onDelete={() => deleteIngredient(ing.id)}
                />
              ))}
            </tbody>
          </table>
        )}

        <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <input
            value={newIng.name}
            onChange={(e) => setNewIng({ ...newIng, name: e.target.value })}
            placeholder="Ingredient name"
            className="flex-1 min-w-[180px] rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
          <input
            value={newIng.dosage}
            onChange={(e) => setNewIng({ ...newIng, dosage: e.target.value })}
            placeholder="Dosage (optional, e.g. 500mg, 10 billion CFU)"
            className="w-64 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
          <button
            onClick={addIngredient}
            disabled={busy || !newIng.name.trim()}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            Add
          </button>
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p className="text-xs text-zinc-500">
            Starts AI research on all ingredients and analysis of existing reviews in parallel.
          </p>
          <button
            onClick={startResearch}
            disabled={busy || overview.ingredients.length === 0}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {busy ? "Starting..." : "Start Research"}
          </button>
        </div>
      </div>
    </div>
  );
}

function IngredientRow({
  ingredient,
  onUpdate,
  onDelete,
}: {
  ingredient: Ingredient;
  onUpdate: (patch: Partial<Ingredient>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ingredient.name);
  const [dosage, setDosage] = useState(ingredient.dosage_display || "");

  const save = async () => {
    await onUpdate({ name, dosage_display: dosage || null });
    setEditing(false);
  };

  if (editing) {
    return (
      <tr className="border-b border-zinc-100 dark:border-zinc-800/50">
        <td className="py-2 pr-2">
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800" />
        </td>
        <td className="py-2 pr-2">
          <input value={dosage} onChange={(e) => setDosage(e.target.value)} placeholder="e.g. 500mg" className="w-40 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800" />
        </td>
        <td className="py-2 text-right">
          <button onClick={save} className="mr-2 text-xs font-medium text-indigo-500 hover:text-indigo-700">Save</button>
          <button onClick={() => setEditing(false)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-zinc-100 dark:border-zinc-800/50">
      <td className="py-2 text-zinc-900 dark:text-zinc-100">{ingredient.name}</td>
      <td className="py-2 text-zinc-600 dark:text-zinc-400">{ingredient.dosage_display || "—"}</td>
      <td className="py-2 text-right">
        <button onClick={() => setEditing(true)} className="mr-2 text-xs text-zinc-500 hover:text-zinc-700">Edit</button>
        <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600">Delete</button>
      </td>
    </tr>
  );
}

// =============================================================================
// Stage 2: Research
// =============================================================================

function ResearchStage({
  workspaceId,
  productId,
  overview,
  onChange,
  setError,
}: {
  workspaceId: string;
  productId: string;
  overview: Overview;
  onChange: () => void;
  setError: (v: string | null) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const isPending = overview.product.intelligence_status === "researching";

  const reResearch = async (ingredientIds?: string[]) => {
    setBusy(true);
    setError(null);
    const body = ingredientIds ? { ingredient_ids: ingredientIds } : {};
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    onChange();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          {isPending ? "AI researching ingredients... this may take a minute." : `${overview.research.ingredients_with_research.length} ingredients researched.`}
        </p>
        <button
          onClick={() => reResearch()}
          disabled={busy || isPending}
          className="rounded-md bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300"
        >
          Re-research All
        </button>
      </div>

      {overview.research.ingredients_with_research.map((ing) => (
        <div key={ing.id} className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <button
            onClick={() => setOpen((o) => ({ ...o, [ing.id]: !o[ing.id] }))}
            className="flex w-full items-center justify-between px-5 py-3 text-left"
          >
            <div>
              <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{ing.name}</span>
              <span className="ml-2 text-xs text-zinc-500">{ing.dosage_display}</span>
              <span className="ml-2 text-xs text-zinc-400">{ing.research.length} benefits</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  reResearch([ing.id]);
                }}
                className="text-[10px] text-zinc-500 hover:text-zinc-700"
              >
                Re-research
              </button>
              <span className={`text-zinc-400 transition-transform ${open[ing.id] ? "rotate-90" : ""}`}>&#9656;</span>
            </div>
          </button>
          {open[ing.id] && (
            <div className="space-y-3 border-t border-zinc-200 p-5 dark:border-zinc-800">
              {ing.research.length === 0 && <p className="text-xs text-zinc-500">No research yet.</p>}
              {ing.research.map((r) => (
                <ResearchCard key={r.id} research={r} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ResearchCard({ research }: { research: ResearchRow }) {
  const [showCitations, setShowCitations] = useState(false);
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="mb-2 flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{research.benefit_headline}</h4>
        <ConfidenceBadge value={research.ai_confidence} />
      </div>
      <p className="mb-2 text-sm text-zinc-700 dark:text-zinc-300">{research.mechanism_explanation}</p>
      {research.dosage_comparison && (
        <p className="mb-2 text-xs text-zinc-500"><strong>Dosage:</strong> {research.dosage_comparison}</p>
      )}
      {research.clinically_studied_benefits && research.clinically_studied_benefits.length > 0 && (
        <div className="mb-2 text-xs text-zinc-500">
          <strong>Studied endpoints:</strong> {research.clinically_studied_benefits.join(", ")}
        </div>
      )}
      {research.contraindications && (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Contraindications:</strong> {research.contraindications}
        </div>
      )}
      {research.citations && research.citations.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowCitations(!showCitations)}
            className="text-[10px] text-zinc-500 hover:text-zinc-700"
          >
            {showCitations ? "Hide" : "Show"} {research.citations.length} citation{research.citations.length === 1 ? "" : "s"}
          </button>
          {showCitations && (
            <ul className="mt-1 space-y-1 text-[11px] text-zinc-500">
              {research.citations.map((c, i) => (
                <li key={i}>
                  {c.title} {c.authors && `— ${c.authors}`} {c.journal && `(${c.journal}`}
                  {c.year && `, ${c.year}`}
                  {c.journal && `)`}
                  {c.doi && <span className="ml-1 text-zinc-400">doi:{c.doi}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Stage 3: Review Analysis
// =============================================================================

function ReviewsStage({
  workspaceId,
  productId,
  overview,
  onChange,
  setError,
}: {
  workspaceId: string;
  productId: string;
  overview: Overview;
  onChange: () => void;
  setError: (v: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const a = overview.review_analysis;
  const isAnalyzing = overview.product.intelligence_status === "analyzing_reviews";

  const reAnalyze = async () => {
    setBusy(true);
    setError(null);
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/analyze-reviews`, { method: "POST" });
    setBusy(false);
    onChange();
  };

  if (!a && !isAnalyzing) {
    return <p className="text-sm text-zinc-500">No review analysis yet.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-500">
          {isAnalyzing ? "Analyzing reviews..." : `Based on ${a?.reviews_analyzed_count ?? 0} reviews.`}
        </p>
        <button
          onClick={reAnalyze}
          disabled={busy || isAnalyzing}
          className="rounded-md bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300"
        >
          Re-analyze
        </button>
      </div>

      {a && (
        <>
          <ReviewSection title="Top Benefits Customers Mention">
            <div className="space-y-2">
              {(a.top_benefits || []).map((b, i) => (
                <div key={i} className="rounded border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{b.benefit}</span>
                    <span className="text-xs text-zinc-500">mentioned {b.frequency}×</span>
                  </div>
                  {b.customer_phrases && b.customer_phrases.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[11px] text-zinc-500">Example phrases</summary>
                      <ul className="mt-1 space-y-1 pl-3 text-[11px] text-zinc-600 dark:text-zinc-400">
                        {b.customer_phrases.slice(0, 6).map((p, j) => (
                          <li key={j}>&ldquo;{p}&rdquo;</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </ReviewSection>

          <ReviewSection title="Before & After">
            <div className="grid gap-3 sm:grid-cols-2">
              {(a.before_after_pain_points || []).map((b, i) => (
                <div key={i} className="rounded border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-red-500">Before</div>
                  <div className="mb-2 text-xs text-zinc-700 dark:text-zinc-300">{b.before}</div>
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-emerald-500">After</div>
                  <div className="text-xs text-zinc-700 dark:text-zinc-300">{b.after}</div>
                </div>
              ))}
            </div>
          </ReviewSection>

          <ReviewSection title="Skeptics Who Became Believers">
            <div className="space-y-2">
              {(a.skeptic_conversions || []).map((s, i) => (
                <div key={i} className="rounded border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                  <p className="text-xs italic text-zinc-700 dark:text-zinc-300">&ldquo;{s.quote}&rdquo;</p>
                  <p className="mt-1 text-[10px] text-zinc-500">— {s.reviewer_name || "Anonymous"}</p>
                  {s.summary && <p className="mt-1 text-[11px] text-zinc-500">{s.summary}</p>}
                </div>
              ))}
            </div>
          </ReviewSection>

          <ReviewSection title="Surprise Benefits">
            <ul className="space-y-2">
              {(a.surprise_benefits || []).map((s, i) => (
                <li key={i} className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  <strong>{s.benefit}</strong> — &ldquo;{s.quote}&rdquo;
                </li>
              ))}
            </ul>
          </ReviewSection>

          <ReviewSection title="Most Powerful Phrases">
            <div className="grid gap-2 sm:grid-cols-2">
              {(a.most_powerful_phrases || []).map((p, i) => (
                <div key={i} className="rounded border border-violet-200 bg-violet-50 p-2 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200">
                  &ldquo;{p.phrase}&rdquo;
                  {p.reviewer_name && <span className="mt-1 block text-[10px] text-violet-600">— {p.reviewer_name}</span>}
                </div>
              ))}
            </div>
          </ReviewSection>
        </>
      )}
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      {children}
    </div>
  );
}

// =============================================================================
// Stage 4: Benefit Reconciliation
// =============================================================================

interface ReconcileTheme {
  theme_name: string;
  science_confirmed: boolean;
  customer_confirmed: boolean;
  max_confidence: number | null;
  research_ids: string[];
  ingredient_names: string[];
  customer_benefit_names: string[];
  customer_phrases: string[];
  recommendation: "lead" | "supporting" | "skip";
  reason: string;
}

function BenefitsStage({
  workspaceId,
  productId,
  onChange,
  setError,
}: {
  workspaceId: string;
  productId: string;
  overview: Overview;
  onChange: () => void;
  setError: (v: string | null) => void;
}) {
  const [themes, setThemes] = useState<ReconcileTheme[]>([]);
  const [roles, setRoles] = useState<Record<string, "lead" | "supporting" | "skip">>({});
  const [reconciling, setReconciling] = useState(false);
  const [reconciled, setReconciled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [gapSearching, setGapSearching] = useState<string | null>(null);

  // Load saved selections on mount
  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/benefit-selections`);
      if (res.ok) {
        const d = await res.json();
        const saved = (d.benefits || []) as BenefitSelection[];
        if (saved.length > 0) {
          // Convert saved selections back to themes for display
          const t: ReconcileTheme[] = saved.map(s => ({
            theme_name: s.benefit_name,
            science_confirmed: s.science_confirmed,
            customer_confirmed: s.customer_confirmed,
            max_confidence: s.ai_confidence ?? null,
            research_ids: (s as unknown as Record<string, unknown>).ingredient_research_ids as string[] || [],
            ingredient_names: ((s.notes || "").match(/Ingredients: ([^|]+)/)?.[1] || "").split(", ").filter(Boolean),
            customer_benefit_names: ((s.notes || "").match(/Customer: (.+)/)?.[1] || "").split(", ").filter(Boolean),
            customer_phrases: s.customer_phrases || [],
            recommendation: s.role as "lead" | "supporting" | "skip",
            reason: "",
          }));
          setThemes(t);
          const r: Record<string, "lead" | "supporting" | "skip"> = {};
          t.forEach(th => { r[th.theme_name] = th.recommendation; });
          setRoles(r);
          setReconciled(true);
        }
      }
      setLoading(false);
    })();
  }, [workspaceId, productId]);

  const reconcile = async () => {
    setReconciling(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/reconcile-benefits`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        const t = (data.themes || []) as ReconcileTheme[];
        setThemes(t);
        const initialRoles: Record<string, "lead" | "supporting" | "skip"> = {};
        t.forEach(th => { initialRoles[th.theme_name] = th.recommendation; });
        setRoles(initialRoles);
        setReconciled(true);
      } else {
        setError("Reconciliation failed");
      }
    } catch (err) {
      setError(String(err));
    }
    setReconciling(false);
  };

  const findStudies = async (theme: ReconcileTheme) => {
    setGapSearching(theme.theme_name);
    setError(null);
    try {
      await fetch(`/api/workspaces/${workspaceId}/products/${productId}/research-gap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theme_name: theme.theme_name,
          customer_benefit_names: theme.customer_benefit_names,
        }),
      });
      // Re-reconcile after gap research completes (give Inngest a moment)
      setTimeout(() => {
        reconcile();
        setGapSearching(null);
      }, 15000);
    } catch (err) {
      setError(String(err));
      setGapSearching(null);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const benefits = themes.map((t, i) => ({
      benefit_name: t.theme_name,
      role: roles[t.theme_name] || t.recommendation,
      display_order: i,
      science_confirmed: t.science_confirmed,
      customer_confirmed: t.customer_confirmed,
      customer_phrases: t.customer_phrases || [],
      ingredient_research_ids: t.research_ids || [],
      ai_confidence: t.max_confidence,
      notes: `${t.ingredient_names.length ? "Ingredients: " + t.ingredient_names.join(", ") : ""}${t.customer_benefit_names.length ? " | Customer: " + t.customer_benefit_names.join(", ") : ""}`,
    }));

    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/benefit-selections`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ benefits }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setError(err.error || "Save failed");
    } else {
      onChange();
    }
    setBusy(false);
  };

  const moveUp = (i: number) => {
    if (i === 0) return;
    const next = [...themes];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    setThemes(next);
  };

  return (
    <div className="space-y-4">
      {loading ? (
        <p className="text-sm text-zinc-500">Loading...</p>
      ) : !reconciled ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
            AI will analyze your ingredient studies and customer reviews,
            then group them into unified benefit themes — matching science to customer voice.
          </p>
          <button
            onClick={reconcile}
            disabled={reconciling}
            className="rounded-md bg-indigo-500 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            {reconciling ? "Analyzing..." : "Reconcile Science + Customer Benefits"}
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-500">
              {themes.length} benefit themes identified. Green = both science + customer. Yellow = science only. Blue = customer only.
              {themes.some(t => !t.science_confirmed && t.customer_confirmed) && (
                <span className="ml-1 font-medium text-blue-600 dark:text-blue-400">Blue rows have a "Find Studies" button to search for backing research.</span>
              )}
            </p>
            <button
              onClick={reconcile}
              disabled={reconciling}
              className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400"
            >
              {reconciling ? "..." : "Re-reconcile"}
            </button>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                  <th className="px-4 py-2">Benefit Theme</th>
                  <th className="px-4 py-2">Science</th>
                  <th className="px-4 py-2">Customers</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {themes.map((t, i) => {
                  const bg =
                    t.science_confirmed && t.customer_confirmed
                      ? "bg-green-50/50 dark:bg-green-950/20"
                      : t.science_confirmed
                        ? "bg-amber-50/50 dark:bg-amber-950/20"
                        : t.customer_confirmed
                          ? "bg-blue-50/50 dark:bg-blue-950/20"
                          : "";
                  const role = roles[t.theme_name] || t.recommendation;
                  const lowConfidence = role === "lead" && typeof t.max_confidence === "number" && t.max_confidence < 0.5;
                  return (
                    <tr key={t.theme_name} className={`border-b border-zinc-100 dark:border-zinc-800/50 ${bg}`}>
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t.theme_name}</div>
                        <div className="mt-0.5 text-[10px] text-zinc-500">{t.reason}</div>
                        {t.ingredient_names.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {t.ingredient_names.map(n => (
                              <span key={n} className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">{n}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {t.science_confirmed ? (
                          <div className="flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full bg-green-500" />
                            {typeof t.max_confidence === "number" && (
                              <span className="text-zinc-600 dark:text-zinc-400">{Math.round(t.max_confidence * 100)}%</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {t.customer_confirmed ? (
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="h-2 w-2 rounded-full bg-blue-500" />
                              <span className="text-zinc-600 dark:text-zinc-400">{t.customer_benefit_names.join(", ")}</span>
                            </div>
                            {t.customer_phrases?.[0] && (
                              <div className="mt-1 max-w-xs truncate text-zinc-500 italic">&ldquo;{t.customer_phrases[0]}&rdquo;</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={role}
                          onChange={(e) => setRoles({ ...roles, [t.theme_name]: e.target.value as "lead" | "supporting" | "skip" })}
                          className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                        >
                          <option value="lead">Lead</option>
                          <option value="supporting">Supporting</option>
                          <option value="skip">Skip</option>
                        </select>
                        {lowConfidence && (
                          <div className="mt-1 text-[10px] text-red-500">Low confidence for lead</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right space-y-1">
                        <button onClick={() => moveUp(i)} disabled={i === 0} className="block text-xs text-zinc-500 hover:text-zinc-700 disabled:opacity-30">↑ Up</button>
                        {!t.science_confirmed && t.customer_confirmed && (
                          <button
                            onClick={() => findStudies(t)}
                            disabled={gapSearching === t.theme_name}
                            className="block rounded bg-blue-100 px-2 py-1 text-[10px] font-medium text-blue-700 hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/30 dark:text-blue-400"
                          >
                            {gapSearching === t.theme_name ? "Searching..." : "Find Studies"}
                          </button>
                        )}
                        {t.science_confirmed && !t.customer_confirmed && typeof t.max_confidence === "number" && t.max_confidence >= 0.7 && (
                          <span className="block text-[10px] text-amber-600 dark:text-amber-400">Strong science — consider marketing</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {themes.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-zinc-500">
                  No benefits to reconcile yet. Run research and review analysis first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-[10px] text-zinc-500">
          Legend: <span className="mx-1 rounded bg-green-100 px-1">green</span>both confirmed,
          <span className="mx-1 rounded bg-amber-100 px-1">amber</span>science only,
          <span className="mx-1 rounded bg-blue-100 px-1">blue</span>customers only
        </p>
        <button
          onClick={save}
          disabled={busy || themes.length === 0}
          className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save Selections"}
        </button>
      </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Stage 5: Content Generation
// =============================================================================

function ContentStage({
  workspaceId,
  productId,
  overview,
  onChange,
  setError,
}: {
  workspaceId: string;
  productId: string;
  overview: Overview;
  onChange: () => void;
  setError: (v: string | null) => void;
}) {
  const [content, setContent] = useState<PageContent | null>(overview.page_content);
  const [draftFields, setDraftFields] = useState<Partial<PageContent>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setContent(overview.page_content);
    setDraftFields({});
  }, [overview.page_content]);

  const generating = overview.product.intelligence_status === "generating_content";

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/generate-content`, { method: "POST" });
    setBusy(false);
    onChange();
  };

  const saveDraft = async () => {
    if (!content) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/page-content/${content.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draftFields),
    });
    if (!res.ok) setError((await res.json()).error || "Save failed");
    else {
      setDraftFields({});
      onChange();
    }
    setBusy(false);
  };

  const approve = async () => {
    if (!content) return;
    setBusy(true);
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/page-content/${content.id}/approve`, { method: "POST" });
    setBusy(false);
    onChange();
  };

  const publish = async () => {
    if (!content) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/page-content/${content.id}/publish`, { method: "POST" });
    if (!res.ok) {
      setError((await res.json()).error || "Publish failed");
    } else {
      onChange();
    }
    setBusy(false);
  };

  if (!content) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-zinc-500">
          {generating ? "Generating content... this may take a minute." : "No content generated yet."}
        </p>
        {!generating && (
          <button
            onClick={regenerate}
            disabled={busy || overview.product.intelligence_status !== "benefits_selected"}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            Generate content
          </button>
        )}
        {overview.product.intelligence_status !== "benefits_selected" && (
          <p className="text-[10px] text-zinc-500">Complete Stage 4 (save benefit selections) before generating content.</p>
        )}
      </div>
    );
  }

  const fieldValue = <K extends keyof PageContent>(key: K): PageContent[K] =>
    (draftFields[key] !== undefined ? (draftFields[key] as PageContent[K]) : content[key]);

  const setField = <K extends keyof PageContent>(key: K, value: PageContent[K]) => {
    setDraftFields((d) => ({ ...d, [key]: value }));
  };

  const editable = true; // Always editable — approve/publish don't lock content

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>Version {content.version}</span>
          <span>·</span>
          <span className="rounded bg-zinc-100 px-2 py-0.5 text-[10px] uppercase tracking-wider dark:bg-zinc-800">
            {content.status}
          </span>
          <span>·</span>
          <span>Generated {new Date(content.generated_at).toLocaleString()}</span>
        </div>
        <div className="flex gap-2">
          {editable && (
            <>
              <button
                onClick={saveDraft}
                disabled={busy || Object.keys(draftFields).length === 0}
                className="rounded-md bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300"
              >
                Save edits
              </button>
              <button
                onClick={regenerate}
                disabled={busy}
                className="rounded-md bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300"
              >
                Regenerate
              </button>
              <button
                onClick={approve}
                disabled={busy}
                className="rounded-md bg-violet-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-600 disabled:opacity-50"
              >
                Approve
              </button>
            </>
          )}
          {(content.status === "approved" || content.status === "draft") && (
            <button
              onClick={publish}
              disabled={busy}
              className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              Publish
            </button>
          )}
        </div>
      </div>

      <ContentField label="Hero Headline" editable={editable}>
        <input
          value={fieldValue("hero_headline") || ""}
          onChange={(e) => setField("hero_headline", e.target.value)}
          disabled={!editable}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
      </ContentField>

      <ContentField label="Hero Subheadline" editable={editable}>
        <textarea
          value={fieldValue("hero_subheadline") || ""}
          onChange={(e) => setField("hero_subheadline", e.target.value)}
          disabled={!editable}
          rows={2}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
      </ContentField>

      <ContentField label="Benefit Bar" editable={editable}>
        <ArrayEditor
          items={fieldValue("benefit_bar") as unknown as ArrayItem[]}
          fields={[{ key: "text", label: "Text" }, { key: "icon_hint", label: "Icon hint" }]}
          onChange={(v) => setField("benefit_bar", v as unknown as PageContent["benefit_bar"])}
          editable={editable}
        />
      </ContentField>

      <ContentField label="Mechanism Copy" editable={editable}>
        <textarea
          value={fieldValue("mechanism_copy") || ""}
          onChange={(e) => setField("mechanism_copy", e.target.value)}
          disabled={!editable}
          rows={6}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
        <p className="mt-1.5 text-[11px] text-zinc-500">
          Powers the &quot;Why this works&quot; section on the PDP. Should deliver on every chip in the Benefit Bar above.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/regenerate-field`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ field: "mechanism_copy" }),
                });
                if (!res.ok) {
                  setError((await res.json()).error || "Regen failed");
                } else {
                  const { value } = await res.json();
                  setField("mechanism_copy", value);
                  onChange();
                }
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-md border border-indigo-500 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:bg-zinc-900"
          >
            {busy ? "Regenerating…" : "Regenerate from Benefit Bar"}
          </button>
          <p className="text-[10px] text-zinc-500">Rewrites this field only — hero copy stays untouched.</p>
        </div>
      </ContentField>

      <ContentField label="Ingredient Cards" editable={editable}>
        <ArrayEditor
          items={fieldValue("ingredient_cards") as unknown as ArrayItem[]}
          fields={[
            { key: "name", label: "Name" },
            { key: "headline", label: "Headline" },
            { key: "body", label: "Body" },
            { key: "image_slot", label: "Image slot" },
          ]}
          onChange={(v) => setField("ingredient_cards", v as unknown as PageContent["ingredient_cards"])}
          editable={editable}
        />
      </ContentField>

      <ContentField label="Comparison Table" editable={editable}>
        <ArrayEditor
          items={fieldValue("comparison_table_rows") as unknown as ArrayItem[]}
          fields={[
            { key: "feature", label: "Feature" },
            { key: "us", label: "Us" },
            { key: "competitor_generic", label: "Generic competitor" },
          ]}
          onChange={(v) => setField("comparison_table_rows", v as unknown as PageContent["comparison_table_rows"])}
          editable={editable}
        />
      </ContentField>

      <ContentField label="FAQ" editable={editable}>
        <ArrayEditor
          items={fieldValue("faq_items") as unknown as ArrayItem[]}
          fields={[{ key: "question", label: "Question" }, { key: "answer", label: "Answer" }]}
          onChange={(v) => setField("faq_items", v as unknown as PageContent["faq_items"])}
          editable={editable}
        />
      </ContentField>

      <ContentField label="Guarantee Copy" editable={editable}>
        <textarea
          value={fieldValue("guarantee_copy") || ""}
          onChange={(e) => setField("guarantee_copy", e.target.value)}
          disabled={!editable}
          rows={3}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
      </ContentField>

      <ContentField label="Knowledge Base Article (markdown)" editable={editable}>
        <textarea
          value={fieldValue("knowledge_base_article") || ""}
          onChange={(e) => setField("knowledge_base_article", e.target.value)}
          disabled={!editable}
          rows={14}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
      </ContentField>

      <ContentField label={`What it doesn't do (required to publish)`} editable={editable}>
        <textarea
          value={fieldValue("kb_what_it_doesnt_do") || ""}
          onChange={(e) => setField("kb_what_it_doesnt_do", e.target.value)}
          disabled={!editable}
          rows={4}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
      </ContentField>

      <ContentField label="Support Macros" editable={editable}>
        <ArrayEditor
          items={fieldValue("support_macros") as unknown as ArrayItem[]}
          fields={[
            { key: "title", label: "Title" },
            { key: "question_type", label: "Question type" },
            { key: "body_text", label: "Body text" },
          ]}
          onChange={(v) => setField("support_macros", v as unknown as PageContent["support_macros"])}
          editable={editable}
        />
      </ContentField>

      <div className="rounded border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
        <strong className="mb-1 block uppercase tracking-wider text-zinc-500">FDA Disclaimer (locked)</strong>
        {content.fda_disclaimer}
      </div>
    </div>
  );
}

function ContentField({ label, editable, children }: { label: string; editable: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {label}
        {!editable && <span className="ml-2 text-[10px] font-normal text-zinc-400">(locked — approved or published)</span>}
      </label>
      {children}
    </div>
  );
}

type ArrayItem = Record<string, unknown>;

function ArrayEditor({
  items,
  fields,
  onChange,
  editable,
}: {
  items: ArrayItem[] | undefined;
  fields: Array<{ key: string; label: string }>;
  onChange: (v: ArrayItem[]) => void;
  editable: boolean;
}) {
  const list = items || [];
  const update = (i: number, key: string, v: string) => {
    const next = [...list];
    next[i] = { ...next[i], [key]: v };
    onChange(next);
  };
  const remove = (i: number) => {
    onChange(list.filter((_, j) => j !== i));
  };
  const add = () => {
    const empty: ArrayItem = {};
    fields.forEach((f) => (empty[f.key] = ""));
    onChange([...list, empty]);
  };

  return (
    <div className="space-y-2">
      {list.map((item, i) => (
        <div key={i} className="rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">#{i + 1}</span>
            {editable && (
              <button onClick={() => remove(i)} className="text-[10px] text-red-400 hover:text-red-600">
                Remove
              </button>
            )}
          </div>
          <div className="space-y-2">
            {fields.map((f) => {
              const val = typeof item[f.key] === "string" ? (item[f.key] as string) : JSON.stringify(item[f.key] ?? "");
              return (
                <div key={f.key}>
                  <label className="mb-0.5 block text-[10px] text-zinc-500">{f.label}</label>
                  <textarea
                    value={val}
                    disabled={!editable}
                    onChange={(e) => update(i, f.key, e.target.value)}
                    rows={f.key === "body_text" || f.key === "answer" || f.key === "body" ? 3 : 1}
                    className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {editable && (
        <button onClick={add} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300">
          + Add item
        </button>
      )}
    </div>
  );
}

// =============================================================================
// Image Management (always visible)
// =============================================================================

function ImageManagement({
  workspaceId,
  productId,
  overview,
  onChange,
}: {
  workspaceId: string;
  productId: string;
  overview: Overview;
  onChange: () => void;
}) {
  const ingredientSlots = useMemo(
    () =>
      overview.ingredients.map((i) => `ingredient_${i.name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")}`),
    [overview.ingredients],
  );

  const slots = useMemo(() => {
    const base = ["hero", "lifestyle_1", "lifestyle_2", "packaging", ...ingredientSlots, "ugc_1", "ugc_2", "ugc_3", "ugc_4", "ugc_5", "ugc_6", "comparison"];
    const seen = new Set<string>();
    return base.filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });
  }, [ingredientSlots]);

  const mediaBySlot = useMemo(() => {
    const map = new Map<string, MediaItem>();
    for (const m of overview.media) map.set(m.slot, m);
    return map;
  }, [overview.media]);

  return (
    <div className="mt-10 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Image Management</h2>
      <p className="mb-4 text-xs text-zinc-500">Upload images for each slot used by the generated content.</p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {slots.map((slot) => (
          <MediaSlot
            key={slot}
            slot={slot}
            media={mediaBySlot.get(slot)}
            workspaceId={workspaceId}
            productId={productId}
            onChange={onChange}
          />
        ))}
      </div>
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
    onChange();
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
      <div className="mb-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">{slot}</div>
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

// =============================================================================
// SEO: Keyword Research + On-Page Optimization
// =============================================================================

interface SEOKeyword {
  id: string;
  keyword: string;
  monthly_searches: number;
  competition: string;
  competition_index: number;
  cpc_low_cents: number;
  cpc_high_cents: number;
  relevance: string;
  is_selected: boolean;
  source: string;
  search_console_clicks: number;
  search_console_impressions: number;
  search_console_ctr: number;
  search_console_position: number;
}

function SEOStage({
  workspaceId,
  productId,
  setError,
}: {
  workspaceId: string;
  productId: string;
  setError: (e: string | null) => void;
}) {
  const [keywords, setKeywords] = useState<SEOKeyword[]>([]);
  const [seoMeta, setSeoMeta] = useState<{ title: string; description: string; keywords: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [researching, setResearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDesc, setSeoDesc] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/seo-keywords`);
    if (res.ok) {
      const data = await res.json();
      setKeywords(data.keywords || []);
      setSeoMeta(data.seo_meta);
      if (data.seo_meta?.title) setSeoTitle(data.seo_meta.title);
      if (data.seo_meta?.description) setSeoDesc(data.seo_meta.description);
    }
    setLoading(false);
  }, [workspaceId, productId]);

  useEffect(() => { load(); }, [load]);

  const startResearch = async () => {
    setResearching(true);
    setError(null);
    try {
      await fetch(`/api/workspaces/${workspaceId}/products/${productId}/seo-keywords`, { method: "POST" });
      // Poll for results
      const poll = setInterval(async () => {
        const res = await fetch(`/api/workspaces/${workspaceId}/products/${productId}/seo-keywords`);
        if (res.ok) {
          const data = await res.json();
          if (data.keywords?.length > 0) {
            setKeywords(data.keywords);
            setResearching(false);
            clearInterval(poll);
          }
        }
      }, 5000);
      setTimeout(() => { clearInterval(poll); setResearching(false); }, 120000);
    } catch (err) {
      setError(String(err));
      setResearching(false);
    }
  };

  const toggleKeyword = (keyword: string) => {
    setKeywords(prev => prev.map(k => k.keyword === keyword ? { ...k, is_selected: !k.is_selected } : k));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const selected = keywords.filter(k => k.is_selected).map(k => k.keyword);
    await fetch(`/api/workspaces/${workspaceId}/products/${productId}/seo-keywords`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selected_keywords: selected,
        seo_title: seoTitle,
        seo_description: seoDesc,
        seo_keywords: selected,
      }),
    });
    setSaving(false);
  };

  if (loading) return <p className="text-sm text-zinc-400">Loading...</p>;

  const selected = keywords.filter(k => k.is_selected);
  const primaryKw = keywords.filter(k => k.relevance === "primary" && k.monthly_searches > 0);
  const secondaryKw = keywords.filter(k => k.relevance === "secondary" && k.monthly_searches > 0);
  const longTail = keywords.filter(k => (k.relevance === "long_tail" || !k.monthly_searches) && k.source !== "search_console");
  const fromConsole = keywords.filter(k => k.source === "search_console" || k.search_console_impressions > 0);

  return (
    <div className="space-y-6">
      {/* Research button */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-zinc-500">
            {keywords.length > 0
              ? `${keywords.length} keywords researched · ${selected.length} selected`
              : "Run keyword research to find SEO opportunities based on your product benefits and ingredients."
            }
          </p>
        </div>
        <button
          onClick={startResearch}
          disabled={researching}
          className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
        >
          {researching ? "Researching..." : keywords.length > 0 ? "Re-research" : "Research Keywords"}
        </button>
      </div>

      {keywords.length > 0 && (
        <>
          {/* SEO Meta Fields */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">SEO Meta Tags</h2>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-medium text-zinc-500">Title Tag <span className="text-zinc-400">({seoTitle.length}/60 chars)</span></span>
              <input
                value={seoTitle}
                onChange={e => setSeoTitle(e.target.value)}
                placeholder="e.g. Amazing Mushroom Coffee | 12 Superfoods | Superfoods Company"
                maxLength={60}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-zinc-500">Meta Description <span className="text-zinc-400">({seoDesc.length}/160 chars)</span></span>
              <textarea
                value={seoDesc}
                onChange={e => setSeoDesc(e.target.value)}
                placeholder="Compelling description with target keywords..."
                maxLength={160}
                rows={3}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              />
            </label>
          </div>

          {/* Search Console — existing rankings */}
          {fromConsole.length > 0 && (
            <KeywordTable
              title="Already Ranking (Search Console)"
              subtitle="Keywords you're already appearing for in Google"
              keywords={fromConsole}
              onToggle={toggleKeyword}
              showConsoleData
            />
          )}

          {/* Primary keywords (1000+ searches) */}
          {primaryKw.length > 0 && (
            <KeywordTable
              title="High Volume Keywords"
              subtitle="1,000+ monthly searches — competitive but high potential"
              keywords={primaryKw}
              onToggle={toggleKeyword}
            />
          )}

          {/* Secondary keywords (100-999 searches) */}
          {secondaryKw.length > 0 && (
            <KeywordTable
              title="Medium Volume Keywords"
              subtitle="100-999 monthly searches — good balance of volume and competition"
              keywords={secondaryKw}
              onToggle={toggleKeyword}
            />
          )}

          {/* Long tail */}
          {longTail.length > 0 && (
            <KeywordTable
              title="Long-Tail Keywords"
              subtitle="Lower volume but easier to rank — great for content and ads"
              keywords={longTail}
              onToggle={toggleKeyword}
            />
          )}

          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-indigo-500 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save SEO Settings"}
          </button>
        </>
      )}
    </div>
  );
}

function KeywordTable({
  title,
  subtitle,
  keywords,
  onToggle,
  showConsoleData = false,
}: {
  title: string;
  subtitle: string;
  keywords: SEOKeyword[];
  onToggle: (keyword: string) => void;
  showConsoleData?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        <p className="text-xs text-zinc-500">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
              <th className="px-4 py-2 w-8"></th>
              <th className="px-4 py-2">Keyword</th>
              <th className="px-4 py-2 text-right">Monthly Searches</th>
              <th className="px-4 py-2">Competition</th>
              <th className="px-4 py-2 text-right">CPC</th>
              {showConsoleData && (
                <>
                  <th className="px-4 py-2 text-right">Clicks</th>
                  <th className="px-4 py-2 text-right">Impressions</th>
                  <th className="px-4 py-2 text-right">Position</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {keywords.map(k => (
              <tr key={k.keyword} className={`border-b border-zinc-100 dark:border-zinc-800/50 ${k.is_selected ? "bg-indigo-50/50 dark:bg-indigo-950/20" : ""}`}>
                <td className="px-4 py-2">
                  <input
                    type="checkbox"
                    checked={k.is_selected}
                    onChange={() => onToggle(k.keyword)}
                    className="rounded border-zinc-300 text-indigo-500"
                  />
                </td>
                <td className="px-4 py-2 text-zinc-900 dark:text-zinc-100">{k.keyword}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                  {k.monthly_searches > 0 ? k.monthly_searches.toLocaleString() : "—"}
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    k.competition === "LOW" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : k.competition === "MEDIUM" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                    : k.competition === "HIGH" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                  }`}>
                    {k.competition}
                  </span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-500">
                  {k.cpc_high_cents > 0 ? `$${(k.cpc_high_cents / 100).toFixed(2)}` : "—"}
                </td>
                {showConsoleData && (
                  <>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-600">{k.search_console_clicks || "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-600">{k.search_console_impressions || "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-600">{k.search_console_position ? k.search_console_position.toFixed(1) : "—"}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
