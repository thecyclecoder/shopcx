/**
 * Ad tool — Phase 2 demographic-driven avatar proposals.
 *
 * Reads who actually buys a product (the FOUR-field demographic tuple only:
 * gender, age range, life stage, income bracket) and asks Opus for archetype
 * briefs the operator confirms BEFORE any photo upload or Higgsfield spend.
 *
 * READ-ONLY consumer of the demographic-enrichment pipeline — never writes to
 * customer_demographics. Explicitly does NOT use health_priorities, buyer_type,
 * or urban/geo fields (see docs/brain/specs/ad-tool.md Phase 2).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Below this many unique (link-deduped) buyers, fall back to the workspace-wide
// snapshot rather than deriving a per-product archetype from noise.
const MIN_COHORT = 30;
const GENDER_CONF_FLOOR = 0.6;

type Tuple = { gender: string; age_range: string; life_stage: string; income_bracket: string };

/** `.in()` against a column, chunked so large id lists don't exceed PostgREST URL limits. */
async function batchedIn(admin: ReturnType<typeof createAdminClient>, table: string, cols: string, ids: string[], chunk = 200): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const { data } = await admin.from(table).select(cols).in("customer_id", slice);
    if (data) out.push(...data);
  }
  return out;
}

export interface ArchetypeBrief {
  name: string;
  wardrobe: string;
  setting: string;
  hook_delivery_style: string;
  photoshoot_brief: string;
}

export interface DemographicBasis {
  cohort_size: number;
  gender_share: Record<string, number>;
  age_range_share: Record<string, number>;
  life_stage_share: Record<string, number>;
  income_bracket_share: Record<string, number>;
  used_fallback_snapshot: boolean;
}

export interface ProposalDraft {
  archetype_brief: ArchetypeBrief;
  demographic_basis: DemographicBasis;
}

function share(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  const total = values.length || 1;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(counts)) out[k] = Math.round((n / total) * 100) / 100;
  return out;
}

function topKey(rec: Record<string, number>): string {
  let best = "";
  let bestV = -1;
  for (const [k, v] of Object.entries(rec)) if (v > bestV) ((best = k), (bestV = v));
  return best;
}

/** Resolve the unique buyer cohort (link-group deduped) for a product title stem. */
async function loadCohortTuples(workspaceId: string, titleStem: string): Promise<Tuple[]> {
  const admin = createAdminClient();
  const { data: cohort } = await admin.rpc("ad_product_cohort", { p_workspace_id: workspaceId, p_title_stem: titleStem });
  const customerIds = (cohort || []).map((r: { customer_id: string }) => r.customer_id);
  if (!customerIds.length) return [];

  // Collapse each person to one via customer_links group. Batch the .in() — a
  // single .in() with ~1000 UUIDs blows past PostgREST's URL limits.
  const links = await batchedIn(admin, "customer_links", "group_id, customer_id", customerIds);
  const groupByCustomer = new Map<string, string>();
  for (const l of links) groupByCustomer.set(l.customer_id, l.group_id);
  const seenGroups = new Set<string>();
  const dedupedCustomerIds: string[] = [];
  for (const cid of customerIds) {
    const g = groupByCustomer.get(cid) || cid; // ungrouped customers count as their own group
    if (seenGroups.has(g)) continue;
    seenGroups.add(g);
    dedupedCustomerIds.push(cid);
  }

  const demos = await batchedIn(
    admin,
    "customer_demographics",
    "inferred_gender, inferred_gender_conf, inferred_age_range, inferred_life_stage, zip_income_bracket",
    dedupedCustomerIds,
  );

  const tuples: Tuple[] = [];
  for (const d of demos) {
    if (!d.inferred_gender || d.inferred_gender === "unknown") continue;
    if ((d.inferred_gender_conf ?? 0) < GENDER_CONF_FLOOR) continue;
    tuples.push({
      gender: d.inferred_gender,
      age_range: d.inferred_age_range || "unknown",
      life_stage: d.inferred_life_stage || "unknown",
      income_bracket: d.zip_income_bracket || "unknown",
    });
  }
  return tuples;
}

function tuplesToBasis(tuples: Tuple[], usedFallback: boolean): DemographicBasis {
  return {
    cohort_size: tuples.length,
    gender_share: share(tuples.map((t) => t.gender)),
    age_range_share: share(tuples.map((t) => t.age_range)),
    life_stage_share: share(tuples.map((t) => t.life_stage)),
    income_bracket_share: share(tuples.map((t) => t.income_bracket)),
    used_fallback_snapshot: usedFallback,
  };
}

/** Group buyers into the top archetypes by (gender, age, life_stage, income) tuple share. */
function topArchetypes(tuples: Tuple[], k: number): Array<{ tuple: Tuple; share: number }> {
  const counts = new Map<string, { tuple: Tuple; n: number }>();
  for (const t of tuples) {
    const key = `${t.gender}|${t.age_range}|${t.life_stage}|${t.income_bracket}`;
    const cur = counts.get(key);
    if (cur) cur.n++;
    else counts.set(key, { tuple: t, n: 1 });
  }
  const total = tuples.length || 1;
  return Array.from(counts.values())
    .sort((a, b) => b.n - a.n)
    .slice(0, k)
    .map((c) => ({ tuple: c.tuple, share: Math.round((c.n / total) * 100) / 100 }));
}

async function briefFromOpus(
  workspaceId: string,
  productTitle: string,
  tuple: Tuple,
  sharePct: number,
  angles: Array<{ hook_slug: string; lf8_slot: number; hook_one_liner: string }>,
): Promise<ArchetypeBrief> {
  const fallback: ArchetypeBrief = {
    name: `${tuple.gender === "female" ? "Woman" : "Man"}, ${tuple.age_range}`,
    wardrobe: "casual, relatable, true-to-life",
    setting: "everyday home kitchen",
    hook_delivery_style: angles[0]?.hook_slug || "problem_now",
    photoshoot_brief: `A ${tuple.gender}, apparent age ${tuple.age_range}, ${tuple.life_stage} life stage, ${tuple.income_bracket} income setting. Natural light, phone-camera feel, holding the product.`,
  };
  if (!ANTHROPIC_API_KEY) return fallback;

  const system = `You design avatar archetype briefs for direct-response ads. You receive a buyer demographic tuple (gender, apparent age band, life stage, income bracket) and the product's ad angles. Return a brief for a believable on-camera person who matches the ACTUAL buyer. Anchor wardrobe + setting to the income bracket + life stage ONLY — never to health interests. Return ONLY JSON: { name, wardrobe, setting, hook_delivery_style, photoshoot_brief }.`;
  const user = `Product: ${productTitle}\nBuyer archetype (${Math.round(sharePct * 100)}% of buyers): ${JSON.stringify(tuple)}\nAngles this avatar will deliver: ${JSON.stringify(angles.slice(0, 6))}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: OPUS_MODEL, max_tokens: 800, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) return fallback;
    const json = await res.json();
    if (json?.usage) {
      try {
        await logAiUsage({ workspaceId, model: OPUS_MODEL, usage: json.usage, purpose: "ad_avatar_proposal", ticketId: null });
      } catch {}
    }
    const text = (json?.content?.[0]?.text || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    const obj = JSON.parse(text.slice(first, last + 1));
    return {
      name: String(obj.name || fallback.name),
      wardrobe: String(obj.wardrobe || fallback.wardrobe),
      setting: String(obj.setting || fallback.setting),
      hook_delivery_style: String(obj.hook_delivery_style || fallback.hook_delivery_style),
      photoshoot_brief: String(obj.photoshoot_brief || fallback.photoshoot_brief),
    };
  } catch {
    return fallback;
  }
}

export interface GenerateProposalsResult {
  ok: boolean;
  proposals: ProposalDraft[];
  reason?: string;
}

interface CachedArchetypes {
  basis: DemographicBasis;
  archetypes: Array<{ tuple: Tuple; share: number }>;
}

// Re-derive archetypes from raw demographics only when the cache is older than
// this (the aggregate behind a large cohort barely moves day-to-day).
const ARCHETYPE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve the joint four-field archetypes + cohort basis for a product, reading
 * the write-through cache on demographics_snapshots.archetype_tuples when fresh.
 * Only recomputes from raw customer_demographics when the cache is absent/stale
 * or forceRefresh is set — so repeat "Suggest avatars" clicks are cheap.
 */
async function resolveArchetypes(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  productId: string,
  productTitle: string,
  maxArchetypes: number,
  forceRefresh: boolean,
): Promise<{ archetypes: Array<{ tuple: Tuple; share: number }>; basis: DemographicBasis; fromCache: boolean } | null> {
  if (!forceRefresh) {
    const { data: cacheRow } = await admin
      .from("demographics_snapshots")
      .select("archetype_tuples, computed_at")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .maybeSingle();
    const cached = cacheRow?.archetype_tuples as (CachedArchetypes & { computed_at?: string }) | null;
    if (cached?.archetypes?.length) {
      const ts = cached.computed_at ? Date.parse(cached.computed_at) : 0;
      // Date.now() is unavailable in some sandboxes but fine in app/inngest runtime.
      const fresh = ts > 0 && Date.now() - ts < ARCHETYPE_CACHE_TTL_MS;
      if (fresh) return { archetypes: cached.archetypes, basis: cached.basis, fromCache: true };
    }
  }

  // Cache miss / stale / forced → compute live from the cohort.
  const stem = (productTitle || "").split(/\s+/).slice(0, 2).join(" ").trim() || productTitle;
  let tuples = await loadCohortTuples(workspaceId, stem);
  let usedFallback = false;
  if (tuples.length < MIN_COHORT) {
    usedFallback = true;
    const { data: snap } = await admin
      .from("demographics_snapshots")
      .select("gender_distribution, age_distribution, income_distribution")
      .eq("workspace_id", workspaceId)
      .is("product_id", null)
      .maybeSingle();
    if (snap) {
      const g = topKey(snap.gender_distribution || {}) || "female";
      const a = topKey(snap.age_distribution || {}) || "35-44";
      const inc = topKey(snap.income_distribution || {}) || "60-80k";
      tuples = [{ gender: g, age_range: a, life_stage: "family", income_bracket: inc }];
    }
  }
  if (!tuples.length) return null;

  const archetypes = topArchetypes(tuples, usedFallback ? 1 : maxArchetypes);
  const basis = tuplesToBasis(tuples, usedFallback);

  // Write-through cache. Upsert on (workspace_id, product_id); the snapshot's
  // other columns keep their NOT NULL DEFAULTs when this row is new.
  try {
    await admin
      .from("demographics_snapshots")
      .upsert(
        { workspace_id: workspaceId, product_id: productId, archetype_tuples: { basis, archetypes, computed_at: new Date().toISOString() } },
        { onConflict: "workspace_id,product_id" },
      );
  } catch {
    /* cache write is best-effort */
  }
  return { archetypes, basis, fromCache: false };
}

/**
 * Generate 2-4 archetype proposals for a product and insert them as
 * `status='proposed'` rows. No Higgsfield spend — Opus-only, single-digit cents.
 * Archetypes come from the write-through cache on demographics_snapshots unless
 * `forceRefresh` is set (or the cache is stale).
 */
export async function generateAvatarProposals(productId: string, maxArchetypes = 4, forceRefresh = false): Promise<GenerateProposalsResult> {
  const admin = createAdminClient();
  const { data: product } = await admin.from("products").select("id, workspace_id, title").eq("id", productId).single();
  if (!product) return { ok: false, proposals: [], reason: "product_not_found" };
  const workspaceId = product.workspace_id as string;

  const resolved = await resolveArchetypes(admin, workspaceId, productId, product.title, maxArchetypes, forceRefresh);
  if (!resolved) return { ok: false, proposals: [], reason: "no_demographic_data" };
  const { archetypes, basis } = resolved;

  const { data: angleRows } = await admin
    .from("product_ad_angles")
    .select("hook_slug, lf8_slot, hook_one_liner")
    .eq("product_id", productId)
    .eq("is_active", true)
    .limit(12);
  const angles = angleRows || [];

  const proposals: ProposalDraft[] = [];
  const rows: any[] = [];
  for (const arch of archetypes) {
    const brief = await briefFromOpus(workspaceId, product.title, arch.tuple, arch.share, angles);
    const draft: ProposalDraft = { archetype_brief: brief, demographic_basis: { ...basis, cohort_size: basis.cohort_size } };
    proposals.push(draft);
    rows.push({
      workspace_id: workspaceId,
      product_id: productId,
      archetype_brief: brief,
      demographic_basis: draft.demographic_basis,
      status: "proposed",
    });
  }

  if (rows.length) {
    const { error } = await admin.from("ad_avatar_proposals").insert(rows);
    if (error) return { ok: false, proposals: [], reason: error.message };
  }
  return { ok: true, proposals };
}
