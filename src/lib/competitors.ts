/**
 * Competitor Scout — DB-driven per-product competitor set (docs/brain/specs/competitor-scout.md).
 *
 * The foundation of the Acquisition Research Engine (M1). Owns the `competitors` table that
 * replaces the hardcoded COMPETITOR_SEEDS: a curated, supervisable set the creative-finder sweep
 * (and the downstream ad-creative-scout / landing-page-scout) read from.
 *
 * North-star (supervisable autonomy): the discovery agent only ever writes status='proposed' rows
 * WITH evidence; an owner approves → 'approved' before anything enters the live sweep. The proxy
 * (heavy advertiser longevity / web-search "competitor") is bounded; the owner owns the objective.
 *
 * Three signals author proposals:
 *   - discoverCompetitors()    — LLM + web search: the direct competitive set + each brand's domain
 *                                and canonical PDP URLs, framed by the product's intelligence.
 *   - promoteFromCategorySweep — heavy advertisers that recur in AdLibrary category sweeps
 *                                (creative_skeletons rows) get promoted as candidates.
 *   - manual                   — hand-curated (incl. the migrated seeds, seeded 'approved').
 *
 * loadApprovedCompetitorSeeds() is the sweep's read path — it returns ONLY approved rows as Seeds.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import type { Seed } from "@/lib/adlibrary";

export type CompetitorSource = "llm" | "category_sweep" | "manual";
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
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
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

/**
 * The sweep's read path: approved competitors for a workspace, as discovery Seeds (keyword = brand).
 * Empty when no competitor is approved — the sweep then runs ZERO competitor pulls (no hardcoded
 * fallback). This is what replaced the import of COMPETITOR_SEEDS in the creative-finder.
 */
export async function loadApprovedCompetitorSeeds(workspaceId: string): Promise<Seed[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("competitors")
    .select("brand, evidence, category")
    .eq("workspace_id", workspaceId)
    .eq("status", "approved")
    .order("brand", { ascending: true });
  return (data || [])
    .filter((r) => r.brand)
    .map((r) => ({
      keyword: r.brand as string,
      kind: "competitor" as const,
      note: (r.evidence as string) || (r.category as string) || undefined,
    }));
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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
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
    if (!res.ok) throw new Error(`anthropic_${res.status}: ${(await res.text()).slice(0, 200)}`);
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
export async function promoteFromCategorySweep(
  workspaceId: string,
  minAds = 3,
): Promise<PromoteResult> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("creative_skeletons")
    .select("advertiser")
    .eq("workspace_id", workspaceId)
    .eq("source", "adlibrary")
    .not("advertiser", "is", null)
    .limit(5000);

  // Count distinct-ish appearances per advertiser, keep the original display name for evidence.
  const counts = new Map<string, { count: number; display: string }>();
  for (const r of data || []) {
    const display = (r.advertiser as string) || "";
    const brand = normalizeBrand(display);
    if (!brand) continue;
    const cur = counts.get(brand) || { count: 0, display };
    cur.count++;
    counts.set(brand, cur);
  }

  const result: PromoteResult = { promoted: 0, skippedExisting: 0, scanned: counts.size };
  for (const [brand, { count, display }] of counts) {
    if (count < minAds) continue;
    const inserted = await upsertCandidate(workspaceId, {
      brand,
      source: "category_sweep",
      spend_signal: `recurs in ${count} AdLibrary sweep ads`,
      evidence: `Heavy advertiser "${display}" recurred in ${count} category-sweep ads — promote to a tracked competitor?`,
    });
    if (inserted) result.promoted++;
    else result.skippedExisting++;
  }
  return result;
}
