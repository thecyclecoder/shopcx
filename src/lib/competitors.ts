/**
 * Competitor Scout — DB-driven per-product competitor set (docs/brain/specs/competitor-scout.md).
 *
 * The foundation of the Acquisition Research Engine (M1). Owns the `competitors` table: a curated,
 * supervisable, PER-PRODUCT competitor set (`product_id`) the deliberate per-product scout
 * ([[creative-scout]]) and the downstream landing-page-scout read from.
 *
 * North-star (supervisable autonomy): the discovery agent only ever writes status='proposed' rows
 * WITH evidence; an owner approves → 'approved' before anything enters the live scout. The proxy
 * (web-search "competitor") is bounded; the owner owns the objective.
 *
 * Two signals author proposals (category-sweep auto-discovery was RETIRED 2026-07-12 — fully deliberate):
 *   - discoverCompetitors()    — LLM + web search: the direct competitive set + each brand's domain
 *                                and canonical PDP URLs, framed by the product's intelligence.
 *   - manual                   — hand-curated (incl. the migrated seeds, seeded 'approved').
 *
 * loadApprovedCompetitorsForProduct() is the scout's read path — approved rows for ONE product, as Seeds
 * carrying competitorId + productId so every ingested skeleton is tagged with its competitor + product.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import { throwForAnthropicNetworkError, throwForAnthropicStatus } from "@/lib/anthropic-retry";
import type { Seed } from "@/lib/adlibrary";

export type CompetitorSource = "llm" | "category_sweep" | "manual" | "whitelisted";
export type CompetitorStatus = "proposed" | "approved" | "rejected";

export interface CompetitorRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  brand: string;
  domain: string | null;
  pdp_urls: string[];
  category: string | null;
  spend_signal: string | null;
  source: CompetitorSource;
  status: CompetitorStatus;
  evidence: string | null;
  /**
   * Exact AdLibrary keyword the sweep searches for this row (verbatim, NOT `normalizeBrand`-flattened).
   * `source='whitelisted'` rows store the raw page name (e.g. `Holistic Health Finds` → 59 ads; the
   * normalized `holistichealthfinds` → 0). Normal (llm/category_sweep/manual) rows leave this null
   * and the sweep falls back to `brand`. See [[docs/brain/specs/whitelisted-page-auto-tracking]].
   */
  search_keyword: string | null;
  /**
   * For `source='whitelisted'` rows, the competitor whose store this page fronts (the destination
   * -domain join target). ON DELETE SET NULL. Null for real brand competitors.
   */
  runs_ads_for: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  /** winners-flow Phase 1 — the resolved Meta advertiser identity (see src/lib/adlibrary-winners.ts).
   *  `meta_page_id` null = unresolved (bad/ambiguous seed). Populated by the resolve pass. */
  meta_page_id: string | null;
  meta_resolved_name: string | null;
  meta_likes: number | null;
  meta_resolved_via: string | null; // 'name' | 'domain' | null
  meta_resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/* -------------------------------------------------------------------------------------------------
 * SDK chokepoint — the single read/write surface for `public.competitors`.
 *
 * Enforced by `scripts/_check-competitors-sdk-compliance.ts`: any `.from('competitors')` outside
 * this file breaks predeploy red. A hand-rolled query silently reads as empty when a column name
 * is wrong (a workspace with 82 rows once read as 0 because a raw probe selected a non-existent
 * `name` column). The SDK types the row shape and centralizes product-scope semantics.
 * ------------------------------------------------------------------------------------------------- */

/** Args for {@link listCompetitors}. */
export interface ListCompetitorsOptions {
  workspaceId: string;
  /** When set, restricts to rows for that product. Strict per-product by default (Phase 2 target). */
  productId?: string | null;
  status?: CompetitorStatus;
  /**
   * When `productId` is set AND this is true, ALSO include workspace-level rows (`product_id IS NULL` —
   * the legacy migrated seeds). Default false — a productId returns strictly that product's rows.
   * Phase 2 of [[competitor-sdk-chokepoint-and-per-product-cleanup]] retires the last true caller.
   */
  includeUnscoped?: boolean;
  /** Row cap. Default 500 (matches the current owner-list surface). */
  limit?: number;
}

/**
 * List competitor rows for a workspace, optionally scoped to a product / status. The single read
 * chokepoint — every route/lib that used to hand-roll `.from('competitors').select(...)` goes
 * through here.
 */
export async function listCompetitors(opts: ListCompetitorsOptions): Promise<CompetitorRow[]> {
  const admin = createAdminClient();
  let q = admin
    .from("competitors")
    .select("*")
    .eq("workspace_id", opts.workspaceId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.productId) {
    q = opts.includeUnscoped
      ? q.or(`product_id.eq.${opts.productId},product_id.is.null`)
      : q.eq("product_id", opts.productId);
  }
  const { data, error } = await q;
  if (error) throw new Error(`listCompetitors: ${error.message}`);
  return (data ?? []) as unknown as CompetitorRow[];
}

/** Fetch one competitor by id (workspace-scoped when {@link opts.workspaceId} is provided). */
export async function getCompetitor(
  id: string,
  opts: { workspaceId?: string } = {},
): Promise<CompetitorRow | null> {
  const admin = createAdminClient();
  let q = admin.from("competitors").select("*").eq("id", id);
  if (opts.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
  const { data } = await q.maybeSingle();
  return (data as unknown as CompetitorRow | null) ?? null;
}

/**
 * Resolve `runs_ads_for` (self-FK) → fronted competitor's brand for a set of ids. The GET route +
 * acquisition-hub both used to hand-roll this second lookup; the SDK owns it now.
 */
export async function getCompetitorBrandsById(
  workspaceId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const admin = createAdminClient();
  const { data } = await admin
    .from("competitors")
    .select("id, brand")
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  for (const r of data ?? []) map.set(r.id as string, (r.brand as string) || "");
  return map;
}

/** Input shape for {@link upsertCompetitor}. `workspace_id` + `brand` form the unique key. */
export interface UpsertCompetitorInput {
  workspace_id: string;
  brand: string;
  product_id?: string | null;
  domain?: string | null;
  pdp_urls?: string[];
  category?: string | null;
  spend_signal?: string | null;
  source?: CompetitorSource;
  status?: CompetitorStatus;
  evidence?: string | null;
  search_keyword?: string | null;
  runs_ads_for?: string | null;
}

/**
 * General insert-or-update chokepoint on `(workspace_id, brand)`. `discoverCompetitors` /
 * `promoteWhitelistedPages` still use the narrower private `upsertCandidate` (insert-only,
 * dedup-across-all-statuses) — this is the surface for manual/script/backfill writes that want
 * plain upsert semantics.
 */
export async function upsertCompetitor(row: UpsertCompetitorInput): Promise<CompetitorRow> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("competitors")
    .upsert(
      {
        workspace_id: row.workspace_id,
        product_id: row.product_id ?? null,
        brand: row.brand,
        domain: row.domain ?? null,
        pdp_urls: row.pdp_urls ?? [],
        category: row.category ?? null,
        spend_signal: row.spend_signal ?? null,
        source: row.source ?? "manual",
        status: row.status ?? "proposed",
        evidence: row.evidence ?? null,
        search_keyword: row.search_keyword ?? null,
        runs_ads_for: row.runs_ads_for ?? null,
      },
      { onConflict: "workspace_id,brand" },
    )
    .select("*")
    .single();
  if (error) throw new Error(`upsertCompetitor: ${error.message}`);
  return data as unknown as CompetitorRow;
}

/** Options for {@link setCompetitorStatus}. */
export interface SetCompetitorStatusOptions {
  /** Scope-guard: only update the row if it belongs to this workspace. */
  workspaceId?: string;
  /** Compare-and-set guard: only update if the row is currently in this status (idempotent review). */
  expectedStatus?: CompetitorStatus;
}

/**
 * Flip a competitor's status (the approve/reject write path) with an optional workspace scope-guard
 * + expected-status compare-and-set (so a stale async read can't overwrite a settled row). Returns
 * the updated row or null when the guards filtered it out.
 */
export async function setCompetitorStatus(
  id: string,
  status: CompetitorStatus,
  reviewedBy: string,
  note?: string | null,
  opts: SetCompetitorStatusOptions = {},
): Promise<CompetitorRow | null> {
  const admin = createAdminClient();
  let q = admin
    .from("competitors")
    .update({
      status,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      review_note: note ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (opts.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
  if (opts.expectedStatus) q = q.eq("status", opts.expectedStatus);
  const { data, error } = await q.select("*").maybeSingle();
  if (error) throw new Error(`setCompetitorStatus: ${error.message}`);
  return (data as unknown as CompetitorRow | null) ?? null;
}

/** Delete one competitor row (workspace-scoped when {@link opts.workspaceId} is provided). */
/**
 * winners-flow Phase 1 — persist a competitor's resolved Meta advertiser identity (the output of
 * `resolveAdvertiser` in src/lib/adlibrary-winners.ts). Always stamps `meta_resolved_at` so a re-resolve
 * (even one that clears the fields because a brand stopped resolving) is auditable. Workspace-scoped.
 */
export async function setCompetitorMetaResolution(
  id: string,
  resolution: {
    meta_page_id: string | null;
    meta_resolved_name: string | null;
    meta_likes: number | null;
    meta_resolved_via: string | null;
  },
  opts: { workspaceId?: string } = {},
): Promise<void> {
  const admin = createAdminClient();
  let q = admin
    .from("competitors")
    .update({ ...resolution, meta_resolved_at: new Date().toISOString() })
    .eq("id", id);
  if (opts.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
  const { error } = await q;
  if (error) throw new Error(`setCompetitorMetaResolution: ${error.message}`);
}

export async function deleteCompetitor(
  id: string,
  opts: { workspaceId?: string } = {},
): Promise<void> {
  const admin = createAdminClient();
  let q = admin.from("competitors").delete().eq("id", id);
  if (opts.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
  const { error } = await q;
  if (error) throw new Error(`deleteCompetitor: ${error.message}`);
}

/**
 * Orphan competitors: rows with a null `product_id` OR a `product_id` that no longer exists in the
 * workspace's `products` table (deleted / migrated-seed remnants). All 6 hero products now carry
 * their own product-scoped competitors, so the null-scoped legacy seeds are obsolete. Read-only.
 */
export async function listOrphanCompetitors(workspaceId: string): Promise<CompetitorRow[]> {
  const admin = createAdminClient();
  const [{ data: productRows }, { data: rows }] = await Promise.all([
    admin.from("products").select("id").eq("workspace_id", workspaceId),
    admin.from("competitors").select("*").eq("workspace_id", workspaceId),
  ]);
  const liveProductIds = new Set((productRows ?? []).map((p) => p.id as string));
  return ((rows ?? []) as unknown as CompetitorRow[]).filter(
    (r) => !r.product_id || !liveProductIds.has(r.product_id),
  );
}

/**
 * Purge orphan competitors (Phase 3 of [[competitor-sdk-chokepoint-and-per-product-cleanup]]).
 * FK safety: `competitors.runs_ads_for` is a self-FK ON DELETE SET NULL — whitelisted-page rows
 * pointing at a purged brand automatically null their fronted-competitor link, no cascade damage.
 * Returns `{ deleted, ids }`. Idempotent — a re-run on a clean workspace returns `{ deleted: 0 }`.
 */
export async function deleteOrphanCompetitors(
  workspaceId: string,
): Promise<{ deleted: number; ids: string[] }> {
  const orphans = await listOrphanCompetitors(workspaceId);
  if (orphans.length === 0) return { deleted: 0, ids: [] };
  const admin = createAdminClient();
  const ids = orphans.map((r) => r.id);
  const { error } = await admin
    .from("competitors")
    .delete()
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  if (error) throw new Error(`deleteOrphanCompetitors: ${error.message}`);
  return { deleted: ids.length, ids };
}

/**
 * Normalize a brand into the compact handle we use AS the AdLibrary search keyword + the dedup key.
 * Lowercase, strip a domain's protocol/www/TLD path, drop everything non-alphanumeric — so
 * "RYZE Superfoods", "ryzesuperfoods.com", and "ryzesuperfoods" collapse to one handle.
 */
export function normalizeBrand(raw: string): string {
  let s = (raw || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0]; // drop any path
  s = s.replace(/\.(com|co|io|shop|store|net|org)$/i, ""); // drop a trailing TLD
  return s.replace(/[^a-z0-9]/g, "");
}

// loadApprovedCompetitorSeeds — RETIRED 2026-07-12. The workspace-wide read path (ALL approved
// competitors, no product context) fed the old workspace-wide creative-finder sweep. Superseded by
// loadApprovedCompetitorsForProduct below — the deliberate per-product scout reads a product's own shelf.

/**
 * The per-product scout's read path (deliberate imitate, CEO 2026-07-12): the APPROVED competitors we
 * chose FOR ONE product, as discovery Seeds carrying `competitorId` + `productId` so every skeleton the
 * sweep ingests is tagged with the competitor + product it came from.
 *
 * This is what replaced the workspace-wide `loadApprovedCompetitorSeeds` for the scout — a product imitates
 * only ITS shelf. Empty when a product has no approved competitor (the scout then does zero pulls for it).
 * `search_keyword` (the exact page/brand name the AdLibrary API matches literally) wins over `brand`.
 */
export async function loadApprovedCompetitorsForProduct(
  workspaceId: string,
  productId: string,
): Promise<Seed[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("competitors")
    .select("id, brand, search_keyword, evidence, category, domain, resolved_advertiser")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("status", "approved")
    .order("brand", { ascending: true });
  return (data || [])
    .filter((r) => (r.search_keyword as string | null) || r.brand)
    .map((r) => ({
      keyword: ((r.search_keyword as string | null) ?? (r.brand as string)) as string,
      kind: "competitor" as const,
      note: (r.evidence as string) || (r.category as string) || undefined,
      competitorId: r.id as string,
      productId,
      // Relevance-filter inputs (adMatchesCompetitor): keep only ads that actually drive to the
      // competitor's own domain, so a noisy brand-keyword search can't pollute the shelf with wrong-brand ads.
      expectedDomain: (r.domain as string | null) ?? undefined,
      expectedAdvertiser: (r.resolved_advertiser as string | null) ?? (r.brand as string) ?? undefined,
    }));
}

/**
 * Every product in a workspace that has ≥1 APPROVED competitor — the scout's weekly cron work-list.
 * Iterating product-by-product (each with its own small competitor set) is how the scout stays under
 * the AdLibrary rate cap: it never fans 30 competitors at once, only one product's ~5 at a time.
 */
export async function productsWithApprovedCompetitors(workspaceId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("competitors")
    .select("product_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "approved")
    .not("product_id", "is", null);
  return Array.from(new Set((data || []).map((r) => r.product_id as string)));
}

interface ProductIntel {
  id: string;
  title: string;
  product_type: string | null;
  description: string | null;
  tags: string[] | null;
  target_customer: string | null;
  certifications: string[] | null;
}

async function loadProductIntel(workspaceId: string, productId: string): Promise<ProductIntel | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("products")
    .select("id, title, product_type, description, tags, target_customer, certifications")
    .eq("workspace_id", workspaceId)
    .eq("id", productId)
    .single();
  return (data as ProductIntel) ?? null;
}

interface ProposedCompetitor {
  brand: string;
  domain?: string | null;
  pdp_urls?: string[];
  category?: string | null;
  spend_signal?: string | null;
  evidence: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}
interface AnthropicResponse {
  stop_reason?: string;
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

const DISCOVERY_SYSTEM = `You are a DTC competitive-intelligence analyst. Given one of OUR products, identify the REAL direct competitors a shopper cross-shops — brands selling a substitute in the same category to the same buyer, that actively run paid social.

For each competitor return: its compact brand handle (lowercase, no spaces — usable as a search keyword), its canonical domain, 1-3 canonical product/landing-page URLs (the PDP or the page they drive paid traffic to), the category overlap, an ad-spend/longevity signal if you can find one (how heavily/long they advertise), and one-sentence EVIDENCE of why they compete with this product.

Rank by competitive relevance. Exclude marketplaces (Amazon), retailers, and pure-content sites. Prefer brands you can verify run ads.

Return ONLY a JSON array, no prose, no markdown fences:
[{"brand":"...","domain":"...","pdp_urls":["..."],"category":"...","spend_signal":"...","evidence":"..."}]`;

/** Call Opus + web search, resuming through pause_turn, return final text + summed usage. */
async function runDiscovery(
  workspaceId: string,
  brief: string,
): Promise<string> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
  const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: brief }];
  let finalText = "";
  let inTok = 0;
  let outTok = 0;
  for (let i = 0; i < 6; i++) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPUS_MODEL,
          max_tokens: 4000,
          system: DISCOVERY_SYSTEM,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
          messages,
        }),
      });
    } catch (err) {
      // Network blip (undici TypeError: fetch failed / ECONNRESET / ETIMEDOUT / …)
      // → AnthropicDependencyError so Inngest retries with OUTAGE_SPANNING_RETRIES backoff.
      throwForAnthropicNetworkError(err, "competitor-scout-discovery");
    }
    if (!res.ok) {
      // Retryable status (429/5xx/529) → AnthropicDependencyError; terminal (4xx) → NonRetriableError.
      throwForAnthropicStatus(res.status, "competitor-scout-discovery");
    }
    const json = (await res.json()) as AnthropicResponse;
    inTok += json.usage?.input_tokens ?? 0;
    outTok += json.usage?.output_tokens ?? 0;
    finalText = (json.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n")
      .trim();
    if (json.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: json.content });
      continue;
    }
    break;
  }
  await logAiUsage({
    workspaceId,
    model: OPUS_MODEL,
    usage: { input_tokens: inTok, output_tokens: outTok },
    purpose: "competitor-scout-discovery",
  });
  return finalText;
}

function parseProposals(text: string): ProposedCompetitor[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as ProposedCompetitor[];
    return Array.isArray(arr) ? arr.filter((c) => c && c.brand && c.evidence) : [];
  } catch {
    return [];
  }
}

export interface DiscoverResult {
  proposed: number;
  skippedExisting: number;
  candidates: number;
}

/**
 * Discovery pass for ONE product: LLM + web search proposes the competitive set, framed by the
 * product's intelligence. Writes status='proposed', source='llm' rows WITH evidence — never
 * 'approved'. Dedups against any existing row for the workspace+brand (incl. rejected ones, so a
 * rejected competitor never re-surfaces).
 */
export async function discoverCompetitors(
  workspaceId: string,
  productId: string,
): Promise<DiscoverResult> {
  const product = await loadProductIntel(workspaceId, productId);
  if (!product) throw new Error("product_not_found");

  const brief = [
    `OUR product: ${product.title}`,
    product.product_type ? `Category: ${product.product_type}` : "",
    product.target_customer ? `Target customer: ${product.target_customer}` : "",
    (product.tags || []).length ? `Tags/positioning: ${(product.tags || []).join(", ")}` : "",
    (product.certifications || []).length ? `Claims/certs: ${(product.certifications || []).join(", ")}` : "",
    product.description ? `Description: ${product.description.slice(0, 600)}` : "",
    "",
    "Identify the real direct competitors for this product. Use web search to verify their domains and that they run paid social.",
  ]
    .filter(Boolean)
    .join("\n");

  const text = await runDiscovery(workspaceId, brief);
  const proposals = parseProposals(text);
  const result: DiscoverResult = { proposed: 0, skippedExisting: 0, candidates: proposals.length };

  for (const p of proposals) {
    const brand = normalizeBrand(p.brand || p.domain || "");
    if (!brand) continue;
    const inserted = await upsertCandidate(workspaceId, {
      brand,
      product_id: productId,
      domain: p.domain ?? null,
      pdp_urls: Array.isArray(p.pdp_urls) ? p.pdp_urls.filter(Boolean).slice(0, 5) : [],
      category: p.category ?? product.product_type ?? null,
      spend_signal: p.spend_signal ?? null,
      source: "llm",
      evidence: p.evidence,
    });
    if (inserted) result.proposed++;
    else result.skippedExisting++;
  }
  return result;
}

interface CandidateInput {
  brand: string;
  product_id?: string | null;
  domain?: string | null;
  pdp_urls?: string[];
  category?: string | null;
  spend_signal?: string | null;
  source: CompetitorSource;
  evidence: string;
  /** Whitelisted-page rows only: exact AdLibrary page name (verbatim, NOT normalized). */
  search_keyword?: string | null;
  /** Whitelisted-page rows only: the fronted competitor's id. */
  runs_ads_for?: string | null;
}

/**
 * Insert a 'proposed' candidate, deduped on (workspace_id, brand). Returns true if a NEW row was
 * created, false if the brand already exists in ANY status (incl. rejected — so it never
 * re-surfaces). Never overwrites an existing row.
 */
async function upsertCandidate(workspaceId: string, c: CandidateInput): Promise<boolean> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("competitors")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("brand", c.brand)
    .maybeSingle();
  if (existing) return false;

  const { error } = await admin.from("competitors").insert({
    workspace_id: workspaceId,
    product_id: c.product_id ?? null,
    brand: c.brand,
    domain: c.domain ?? null,
    pdp_urls: c.pdp_urls ?? [],
    category: c.category ?? null,
    spend_signal: c.spend_signal ?? null,
    source: c.source,
    status: "proposed",
    evidence: c.evidence,
    search_keyword: c.search_keyword ?? null,
    runs_ads_for: c.runs_ads_for ?? null,
  });
  // A concurrent insert may have won the unique race — treat as "already exists", not new.
  return !error;
}

export interface PromoteResult {
  promoted: number;
  skippedExisting: number;
  scanned: number;
}

/**
 * Category-sweep promotion: heavy advertisers that recur in the AdLibrary sweep output
 * (creative_skeletons) but aren't yet a competitor get proposed as source='category_sweep'.
 * Recurrence = ≥ minAds distinct skeleton rows for that advertiser. Deduped against existing rows
 * (incl. rejected) by normalized brand. Proposed only — never enters the sweep without approval.
 */
/**
 * Extract a bare host from a destination_domain-ish value (`shop.ryzesuperfoods.com`,
 * `https://learn.erthlabs.co/women50`, `learn.erthlabs.co`). Lowercased, protocol/www stripped,
 * path dropped. Empty string when nothing extractable.
 */
function normalizeHost(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0];
  return s;
}

/**
 * Whitelisted-page promotion: propose affiliate/advertorial/creator pages that front a KNOWN
 * competitor as new competitor rows (`source='whitelisted'`, `status='proposed'`).
 *
 * The join key is `creative_skeletons.destination_domain`: a non-brand page whose ads drive to a
 * known competitor's domain is a whitelisted page fronting that competitor. Confirmed live —
 * ~40% of erthlabs's paid social runs under "Holistic Health Finds" (×19) and a network of
 * creator personas; all drive to `learn.erthlabs.co`. Searching the raw page name pulls the
 * WHOLE ad set, and the sibling network unfolds once approved seeds sweep by the exact name.
 *
 * Steps:
 *   1. Build the KNOWN-competitor destination-domain set: distinct hosts observed in
 *      `creative_skeletons.destination_domain` for rows whose `advertiser` (normalized) matches an
 *      approved competitor's `brand` OR whose `seed_keyword` matches. Each host is mapped to that
 *      competitor's `id`. The approved competitor's `domain` column also enters this map so a
 *      competitor with no swept ads yet still anchors its own domain.
 *   2. Group `creative_skeletons` rows by `normalizeBrand(advertiser)`. Skip empty, skip any brand
 *      already approved as a competitor. For each remaining group compute count + share-pointing-
 *      to-known-competitor + the dominant fronted competitor from the group's destination-domain
 *      distribution.
 *   3. If `count >= minAds` AND `share >= minShare`, propose the page as `source='whitelisted'`
 *      with `search_keyword` = the RAW advertiser display (verbatim — the AdLibrary API matches
 *      page names literally), `runs_ads_for` = the fronted competitor's id, and evidence quoting
 *      the N-ads → {domain} → {competitor} link. `upsertCandidate` dedups by normalized brand
 *      across ALL statuses so a rejected/existing page never re-proposes.
 *
 * Proposed only — the owner approves before the sweep uses it (north-star).
 */
export async function promoteWhitelistedPages(
  workspaceId: string,
  { minAds = 3, minShare = 0.5 }: { minAds?: number; minShare?: number } = {},
): Promise<PromoteResult> {
  const admin = createAdminClient();

  // 1. Approved competitors: id, brand, domain, product_id — the fronted-brand anchor set. The
  //    `product_id` is threaded through so a whitelisted-page proposal inherits its fronted
  //    competitor's product scope (Phase 3 of [[competitor-sdk-chokepoint-and-per-product-cleanup]]):
  //    a page fronting an approved competitor with a product_id is a competitor FOR THAT PRODUCT,
  //    not a workspace-level orphan.
  const { data: approvedRows } = await admin
    .from("competitors")
    .select("id, brand, domain, product_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "approved");
  const approvedBrandToId = new Map<string, string>();
  const knownHostToCompetitor = new Map<string, string>();
  const competitorIdToProductId = new Map<string, string | null>();
  for (const r of approvedRows || []) {
    const brand = (r.brand as string | null) || "";
    if (brand) approvedBrandToId.set(brand, r.id as string);
    const host = normalizeHost(r.domain as string | null);
    if (host) knownHostToCompetitor.set(host, r.id as string);
    competitorIdToProductId.set(r.id as string, (r.product_id as string | null) ?? null);
  }

  // Read enough skeleton rows to cover a workspace's daily sweep + a few historical days without
  // paging (limit mirrors promoteFromCategorySweep). Whitelisted detection needs advertiser +
  // destination_domain + seed_keyword together — a row with a null destination_domain is
  // uninformative for this scan (a page that never drives to a competitor domain can't be
  // classified) so we filter it out at query time.
  const { data: skeletons } = await admin
    .from("creative_skeletons")
    .select("advertiser, destination_domain, seed_keyword")
    .eq("workspace_id", workspaceId)
    .eq("source", "adlibrary")
    .not("advertiser", "is", null)
    .not("destination_domain", "is", null)
    .limit(5000);

  // 2. Extend the known-host → competitor map by scanning skeletons where the advertiser or the
  //    seed_keyword resolves to an approved competitor. This catches subdomains the approved row's
  //    `domain` column doesn't list (learn.erthlabs.co vs erthlabs.co).
  for (const r of skeletons || []) {
    const host = normalizeHost(r.destination_domain as string | null);
    if (!host) continue;
    const advBrand = normalizeBrand((r.advertiser as string) || "");
    const seedBrand = normalizeBrand((r.seed_keyword as string) || "");
    const compId = approvedBrandToId.get(advBrand) || approvedBrandToId.get(seedBrand);
    if (compId && !knownHostToCompetitor.has(host)) knownHostToCompetitor.set(host, compId);
  }

  // 3. Group by normalized advertiser. For each non-competitor page, count total + count-known +
  //    the dominant fronted competitor (the competitor id most often pointed at).
  interface PageStat {
    display: string; // the raw advertiser page name for search_keyword
    total: number;
    known: number;
    domainHits: Map<string, number>; // dominant destination_domain (for evidence)
    competitorHits: Map<string, number>; // dominant fronted competitor id
  }
  const pages = new Map<string, PageStat>();
  for (const r of skeletons || []) {
    const display = ((r.advertiser as string) || "").trim();
    if (!display) continue;
    const brand = normalizeBrand(display);
    if (!brand) continue;
    if (approvedBrandToId.has(brand)) continue; // page IS an approved competitor — not a front

    const host = normalizeHost(r.destination_domain as string | null);
    const compId = knownHostToCompetitor.get(host);

    const cur =
      pages.get(brand) ||
      ({ display, total: 0, known: 0, domainHits: new Map(), competitorHits: new Map() } as PageStat);
    cur.total++;
    if (compId) {
      cur.known++;
      cur.competitorHits.set(compId, (cur.competitorHits.get(compId) || 0) + 1);
      if (host) cur.domainHits.set(host, (cur.domainHits.get(host) || 0) + 1);
    }
    pages.set(brand, cur);
  }

  const result: PromoteResult = { promoted: 0, skippedExisting: 0, scanned: pages.size };
  // Approved brand → display name for evidence text.
  const competitorIdToDisplay = new Map<string, string>();
  for (const r of approvedRows || []) competitorIdToDisplay.set(r.id as string, (r.brand as string) || "");

  for (const [brand, stat] of pages) {
    if (stat.total < minAds) continue;
    const share = stat.total > 0 ? stat.known / stat.total : 0;
    if (share < minShare) continue;

    // Pick the dominant fronted competitor + its dominant destination host for evidence.
    let dominantCompId: string | null = null;
    let dominantCompHits = 0;
    for (const [id, n] of stat.competitorHits) {
      if (n > dominantCompHits) {
        dominantCompHits = n;
        dominantCompId = id;
      }
    }
    if (!dominantCompId) continue; // share threshold met but map came up empty — bail defensively.

    let dominantHost = "";
    let dominantHostHits = 0;
    for (const [host, n] of stat.domainHits) {
      if (n > dominantHostHits) {
        dominantHostHits = n;
        dominantHost = host;
      }
    }
    const frontedDisplay = competitorIdToDisplay.get(dominantCompId) || dominantCompId;
    const evidence =
      `${stat.known}/${stat.total} ads → ${dominantHost || "known competitor domain"}, fronting ${frontedDisplay}.` +
      ` Whitelisted-page candidate: search by exact name "${stat.display}".`;

    const inserted = await upsertCandidate(workspaceId, {
      brand,
      // Inherit the fronted competitor's product scope so whitelisted-page proposals are never
      // orphaned (Phase 3). Null when the fronted competitor itself is workspace-level.
      product_id: competitorIdToProductId.get(dominantCompId) ?? null,
      source: "whitelisted",
      search_keyword: stat.display, // RAW page name (verbatim, NOT normalized).
      runs_ads_for: dominantCompId,
      spend_signal: `${stat.total} ads observed (${stat.known} fronting ${frontedDisplay})`,
      evidence,
    });
    if (inserted) result.promoted++;
    else result.skippedExisting++;
  }
  return result;
}

// promoteFromCategorySweep — RETIRED 2026-07-12. Category-sweep competitor auto-discovery (heavy
// advertisers recurring in CATEGORY_SEEDS sweeps → 'proposed' competitors) contradicted the fully-
// deliberate model: competitors are chosen by hand per product (discoverCompetitors proposals + manual),
// never inferred from category keywords. The scout no longer sweeps categories, so there were no
// category skeletons left to promote from. See docs/brain/inngest/creative-scout.md.
