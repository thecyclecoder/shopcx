/**
 * Customer-voice mining reader — Phase 1 of growth-customer-voice-to-ad-angles.
 *
 * Pulls structured fragments of captured customer voice for a workspace+product, returned typed
 * with a `signal` label so a later Phase 2 synthesizer (the Opus pass against the active pattern
 * matrix) can score them into [[../tables/product_ad_angles]] candidates without re-reading raw DB.
 *
 * Three sources, three signals:
 *   - positive review excerpts → signal='positive'  (rating ≥ 4, body present)
 *   - cancel-flow reasons        → signal='objection' (free-text reason captured during cancel-journey)
 *   - support-ticket subjects   → signal='use_case'  (workspace-wide; downstream LLM clusters product)
 *
 * NO LLM call. Pure structured extraction — every fragment carries its source table + row id so
 * Phase 2 can write `metadata.mined_from` arrays back to `product_ad_angles`.
 *
 * Schema reality (the spec mentions a `subscription_events` table that does not exist on main): the
 * canonical cancel-flow reason write today is `customer_events` rows with
 *   event_type='portal.subscription.cancel_reason'
 *   summary='Cancel reason selected: {label}'
 *   properties.reason: <reason slug>
 * — written by `src/lib/portal/handlers/cancel-journey.ts`. We read that.
 *
 * Similarly the spec mentions `tickets.summary` — there is no such column on `tickets`. The
 * AI-generated summary lives on `ticket_analyses.summary`, one-or-more rows per ticket. We read both
 * `tickets.subject` (always present) and join the latest `ticket_analyses.summary` per ticket when
 * available, preferring the richer summary as the fragment text.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import type { PatternMatrix } from "@/lib/creative-skeleton";

type Admin = ReturnType<typeof createAdminClient>;

export type VoiceSignal = "positive" | "objection" | "use_case";
export type VoiceSource = "product_reviews" | "customer_events" | "tickets";

export interface VoiceFragment {
  source: VoiceSource;
  source_id: string;
  text: string;
  signal: VoiceSignal;
}

export interface MineCustomerVoiceOpts {
  workspaceId: string;
  productId: string;
  /** Window of recency for every source. Default 90 days — matches the spec. */
  sinceMs?: number;
}

export interface MineCustomerVoiceResult {
  fragments: VoiceFragment[];
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const CANCEL_REASON_EVENT_TYPE = "portal.subscription.cancel_reason";

interface ReviewRow {
  id: string;
  body: string | null;
  smart_quote: string | null;
  rating: number | null;
}

interface CancelEventRow {
  id: string;
  summary: string | null;
  properties: { reason?: string | null; reasonLabel?: string | null } | null;
}

interface TicketRow {
  id: string;
  subject: string | null;
}

interface TicketAnalysisRow {
  ticket_id: string;
  summary: string | null;
  created_at: string | null;
}

/** Trim + normalize whitespace; drop fragments whose text would be empty after that. */
function clean(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Mine customer voice into typed fragments for a workspace+product.
 *
 * `productId` is the strong product binding for `product_reviews` (which carries a real
 * `product_id` FK). For `customer_events` and `tickets` the schema has no product FK today, so
 * those sources are workspace-scoped only — the downstream Phase 2 synthesizer is responsible for
 * relevance scoring against the named product.
 */
export async function mineCustomerVoice(
  admin: Admin,
  opts: MineCustomerVoiceOpts,
): Promise<MineCustomerVoiceResult> {
  const { workspaceId, productId } = opts;
  const sinceMs = opts.sinceMs ?? NINETY_DAYS_MS;
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();

  const fragments: VoiceFragment[] = [];

  // ── 1. Positive review excerpts ──────────────────────────────────────────────────────────────
  // `product_reviews` is product-scoped via `product_id`. Per [[../tables/product_reviews]] the
  // "Tier-4 PROOF" qualifier is `rating>=4`; we additionally require a non-empty body so the
  // fragment has actual customer language.
  const { data: reviewData } = await admin
    .from("product_reviews")
    .select("id, body, smart_quote, rating")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .gte("rating", 4)
    .gte("created_at", sinceIso)
    .not("body", "is", null);
  for (const r of (reviewData || []) as ReviewRow[]) {
    // Prefer `smart_quote` (Klaviyo-extracted highlight, max ~15 words) when present — it's the
    // most useful piece for an ad — and fall back to the full body.
    const text = clean(r.smart_quote) || clean(r.body);
    if (!text) continue;
    fragments.push({ source: "product_reviews", source_id: r.id, text, signal: "positive" });
  }

  // ── 2. Cancel-flow reasons (objections) ─────────────────────────────────────────────────────
  // The cancel-journey writes a `customer_events` row per reason-step, event_type='portal.subscription.cancel_reason'.
  // The reason label is the human-readable string we want — preferred in `properties.reasonLabel`
  // when present, else the slug in `properties.reason`, else parse from the row's `summary`
  // ("Cancel reason selected: {label}"). The fragment text is whichever is most readable.
  const { data: cancelData } = await admin
    .from("customer_events")
    .select("id, summary, properties")
    .eq("workspace_id", workspaceId)
    .eq("event_type", CANCEL_REASON_EVENT_TYPE)
    .gte("created_at", sinceIso);
  for (const e of (cancelData || []) as CancelEventRow[]) {
    const props = e.properties || {};
    const label = clean(props.reasonLabel) || clean(props.reason);
    const fromSummary = clean(e.summary).replace(/^cancel reason selected:\s*/i, "");
    const text = label || fromSummary;
    if (!text) continue;
    fragments.push({ source: "customer_events", source_id: e.id, text, signal: "objection" });
  }

  // ── 3. Support-ticket themes (use-cases) ────────────────────────────────────────────────────
  // No product FK on `tickets` — workspace-scoped only. We pull each ticket's subject AND, when an
  // analysis exists, the latest `ticket_analyses.summary` (higher-signal). Each ticket produces ONE
  // fragment; summary wins over subject when both exist. Phase 2 LLM clusters the result down to
  // the workspace's named product.
  const { data: ticketData } = await admin
    .from("tickets")
    .select("id, subject")
    .eq("workspace_id", workspaceId)
    .is("merged_into", null)
    .gte("created_at", sinceIso)
    .not("subject", "is", null);
  const ticketRows = (ticketData || []) as TicketRow[];
  if (ticketRows.length > 0) {
    const ticketIds = ticketRows.map((t) => t.id);
    const { data: analysisData } = await admin
      .from("ticket_analyses")
      .select("ticket_id, summary, created_at")
      .in("ticket_id", ticketIds)
      .not("summary", "is", null);
    // Pick the most recent analysis per ticket as the canonical summary.
    const latestSummary = new Map<string, string>();
    for (const a of (analysisData || []) as TicketAnalysisRow[]) {
      const text = clean(a.summary);
      if (!text) continue;
      const prev = latestSummary.get(a.ticket_id);
      if (!prev) latestSummary.set(a.ticket_id, text);
    }
    for (const t of ticketRows) {
      const text = latestSummary.get(t.id) || clean(t.subject);
      if (!text) continue;
      fragments.push({ source: "tickets", source_id: t.id, text, signal: "use_case" });
    }
  }

  return { fragments };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — synthesize + score angle candidates
// ─────────────────────────────────────────────────────────────────────────────
//
// `synthesizeAdAngles({fragments, patternMatrix})` calls Opus ONCE with the
// mined fragments + the active `creative_skeletons` pattern matrix and emits K
// candidate angles `{hook, mechanism_claim, proof, offer, supporting_fragment_ids}`.
// Each candidate is scored deterministically against:
//   (a) cross-brand-repetition overlap with the matrix's slot patterns
//   (b) supporting-fragment density (cited-fragment count vs corpus size)
// Then sorted desc by score. The LLM client is injectable so the unit test
// drives the scorer with a stub and asserts the typed shape + non-zero score
// — no network in tests.
//
// Persistence is a separate step (`persistProposedAngles`) so the synthesizer
// stays pure + testable. Persisted rows land at status='proposed' with
// `metadata={mined_from:{review_ids,cancel_event_ids,ticket_ids}, matrix_overlap,
// score}` — the Phase-3 Director sweep flips status to 'approved' and fans into
// the makers pipeline keyed on the angle id.

const SYNTHESIZE_SYSTEM = `You are a direct-response creative strategist. You synthesize ad-angle candidates that are GROUNDED in the customer's actual voice — never invented.

You are given:
- a list of customer-voice FRAGMENTS, each labeled with a signal: "positive" (praise from a review), "objection" (a cancel-flow reason), or "use_case" (a support theme).
- the active cross-brand PATTERN MATRIX (the slot patterns that repeat across multiple competitor brands today).

For each candidate angle, propose ONE structured row with these four slots:
- hook              — a ≤15-word opening line; can echo a positive fragment or invert an objection.
- mechanism_claim   — the core benefit/mechanism claim, in plain customer language (e.g. "clean energy, no jitters"). Mirror the matrix patterns when one fits.
- proof             — the proof element to anchor it ("3,000+ reviews", "a 12-week study", "founder backstory", etc.).
- offer             — the offer/CTA framing ("subscribe and save", "30-day guarantee", "free shipping", "none").

Plus:
- supporting_fragment_ids — array of fragment ids whose voice this angle is built on. EVERY candidate must cite at least one real fragment id. Do not cite ids that are not in the input.

Return ONLY a JSON object: { "candidates": [ { "hook", "mechanism_claim", "proof", "offer", "supporting_fragment_ids": [...] }, ... ] }. No prose, no markdown fences.`;

export interface AngleCandidateRaw {
  hook: string;
  mechanism_claim: string;
  proof: string;
  offer: string;
  supporting_fragment_ids: string[];
}

export interface AngleCandidate extends AngleCandidateRaw {
  /** Cross-brand-repetition matrix overlap: [0, 1]. */
  matrix_overlap: number;
  /** Supporting-fragment density vs the mined corpus: [0, 1]. */
  density: number;
  /** Convex combination of overlap + density. Always > 0 for a citing candidate. */
  score: number;
}

export interface SynthesizeAngleLLMReq {
  systemPrompt: string;
  userPrompt: string;
  k: number;
}

export interface SynthesizeAngleLLMRes {
  candidates: AngleCandidateRaw[];
}

/** Injectable LLM client. The default talks to Opus via the Anthropic Messages API. */
export type SynthesizeAngleLLM = (req: SynthesizeAngleLLMReq) => Promise<SynthesizeAngleLLMRes>;

export interface SynthesizeAdAnglesOpts {
  fragments: VoiceFragment[];
  patternMatrix: PatternMatrix;
  /** How many candidates to ask the LLM for. Default 8. */
  k?: number;
  /** Inject for tests. Defaults to live Opus. */
  llm?: SynthesizeAngleLLM;
  /** Workspace id for ai-usage logging when using the default LLM. */
  workspaceId?: string;
}

export interface SynthesizeAdAnglesResult {
  candidates: AngleCandidate[];
}

function tokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

/**
 * Deterministic per-slot overlap: for each slot ('hook', 'mechanism_claim', 'proof',
 * 'offer'), the best Jaccard between the candidate's slot value and any
 * patternMatrix.slotPatterns entry for that slot, weighted by that pattern's
 * brandCount. Returned as a normalized [0, 1] value (raw weighted sum divided by
 * the sum of best-per-slot brandCount across the matrix — so an empty matrix
 * yields 0, and a maximally-overlapping candidate trends to 1).
 */
function scoreMatrixOverlap(
  c: AngleCandidateRaw,
  matrix: PatternMatrix,
): number {
  const slots: Array<{ key: keyof AngleCandidateRaw; slot: string }> = [
    { key: "hook", slot: "hook" },
    { key: "mechanism_claim", slot: "mechanism_claim" },
    { key: "proof", slot: "proof" },
    { key: "offer", slot: "offer" },
  ];

  let weighted = 0;
  let maxWeighted = 0;
  for (const { key, slot } of slots) {
    const patternsForSlot = matrix.slotPatterns.filter((p) => p.slot === slot);
    if (patternsForSlot.length === 0) continue;
    const topBrandCount = Math.max(...patternsForSlot.map((p) => p.brandCount));
    maxWeighted += topBrandCount;

    const candTokens = tokens(String(c[key] ?? ""));
    if (!candTokens.size) continue;

    let bestForSlot = 0;
    for (const p of patternsForSlot) {
      const pTokens = tokens(p.label);
      if (!pTokens.size) continue;
      const inter = [...candTokens].filter((t) => pTokens.has(t)).length;
      const union = new Set([...candTokens, ...pTokens]).size;
      const j = union ? inter / union : 0;
      const w = j * p.brandCount;
      if (w > bestForSlot) bestForSlot = w;
    }
    weighted += bestForSlot;
  }
  if (maxWeighted === 0) return 0;
  return Math.min(1, weighted / maxWeighted);
}

/**
 * Supporting-fragment density: how many distinct VALID fragment ids the
 * candidate cites vs the size of the mined corpus, capped at 1. Hallucinated
 * ids (not in the corpus) are dropped before the count.
 */
function scoreDensity(
  c: AngleCandidateRaw,
  fragmentIds: Set<string>,
  corpusSize: number,
): { density: number; validIds: string[] } {
  const validIds = Array.from(
    new Set(c.supporting_fragment_ids.filter((id) => fragmentIds.has(id))),
  );
  if (corpusSize <= 0) return { density: 0, validIds };
  // A single citation against a small corpus already scores meaningfully —
  // the goal is to differentiate citing-vs-not-citing, not to demand most of
  // the corpus per candidate.
  const density = Math.min(1, validIds.length / Math.max(3, Math.ceil(corpusSize / 4)));
  return { density, validIds };
}

function buildUserPrompt(fragments: VoiceFragment[], matrix: PatternMatrix, k: number): string {
  return `Synthesize ${k} candidate ad angles. Inputs are below.

FRAGMENTS (your only allowed source of customer voice — cite by id in supporting_fragment_ids):
${JSON.stringify(
  fragments.map((f) => ({ id: f.source_id, signal: f.signal, text: f.text })),
  null,
  2,
)}

PATTERN MATRIX (cross-brand-repetition slot patterns — mirror these where they fit, but the candidate must still trace back to fragments):
${JSON.stringify(
  {
    generatedFrom: matrix.generatedFrom,
    brandCount: matrix.brandCount,
    slotPatterns: matrix.slotPatterns.map((p) => ({
      slot: p.slot,
      label: p.label,
      brandCount: p.brandCount,
      exampleValues: p.exampleValues,
    })),
  },
  null,
  2,
)}`;
}

/** Strip optional markdown fences; tolerate `{ "candidates": [...] }` or a bare array. */
function parseSynthResponse(text: string): AngleCandidateRaw[] {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  let obj: unknown = null;
  try {
    obj = JSON.parse(stripped);
  } catch {
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first === -1 || last === -1) return [];
    try {
      obj = JSON.parse(stripped.slice(first, last + 1));
    } catch {
      return [];
    }
  }
  const arr = Array.isArray(obj)
    ? obj
    : Array.isArray((obj as { candidates?: unknown[] })?.candidates)
      ? (obj as { candidates: unknown[] }).candidates
      : [];
  return arr.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(o.supporting_fragment_ids)
      ? (o.supporting_fragment_ids as unknown[]).map((x) => String(x))
      : [];
    return {
      hook: String(o.hook ?? ""),
      mechanism_claim: String(o.mechanism_claim ?? ""),
      proof: String(o.proof ?? ""),
      offer: String(o.offer ?? ""),
      supporting_fragment_ids: ids,
    };
  });
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const defaultLLM: SynthesizeAngleLLM = async ({ systemPrompt, userPrompt }) => {
  if (!ANTHROPIC_API_KEY) throw new Error("no_anthropic_key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: OPUS_MODEL,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`opus_${res.status}`);
  const json = (await res.json()) as {
    content?: Array<{ text?: string }>;
    usage?: unknown;
  };
  const text = (json?.content?.[0]?.text || "").trim();
  return { candidates: parseSynthResponse(text), usage: json?.usage } as SynthesizeAngleLLMRes & { usage?: unknown };
};

/**
 * Synthesize + score K ad-angle candidates from mined customer voice against
 * the active cross-brand pattern matrix. Pure scoring; persistence is a
 * separate step.
 */
export async function synthesizeAdAngles(
  opts: SynthesizeAdAnglesOpts,
): Promise<SynthesizeAdAnglesResult> {
  const { fragments, patternMatrix } = opts;
  const k = opts.k ?? 8;
  const llm = opts.llm ?? defaultLLM;
  const systemPrompt = SYNTHESIZE_SYSTEM;
  const userPrompt = buildUserPrompt(fragments, patternMatrix, k);

  const llmRes = (await llm({ systemPrompt, userPrompt, k })) as SynthesizeAngleLLMRes & {
    usage?: unknown;
  };
  // Best-effort ai-usage logging — never block synthesis on telemetry hiccups.
  if (opts.workspaceId && llmRes.usage) {
    try {
      await logAiUsage({
        workspaceId: opts.workspaceId,
        model: OPUS_MODEL,
        usage: llmRes.usage as Parameters<typeof logAiUsage>[0]["usage"],
        purpose: "ad_angle_voice_synth",
        ticketId: null,
      });
    } catch {}
  }

  const fragmentIds = new Set(fragments.map((f) => f.source_id));
  const corpusSize = fragments.length;

  const scored: AngleCandidate[] = [];
  for (const raw of llmRes.candidates) {
    const { density, validIds } = scoreDensity(raw, fragmentIds, corpusSize);
    // A candidate that cites no real fragment is unanchored — drop it. The
    // anchoring contract is the whole point of the voice-mining pipeline.
    if (validIds.length === 0) continue;
    const matrix_overlap = scoreMatrixOverlap(raw, patternMatrix);
    // Convex combination; floored so a citing candidate is never literally 0
    // even when both signals collapse (e.g. empty matrix + tiny corpus).
    const score = Math.max(0.0001, 0.6 * matrix_overlap + 0.4 * density);
    scored.push({
      ...raw,
      supporting_fragment_ids: validIds,
      matrix_overlap,
      density,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return { candidates: scored };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — write scored candidates to `product_ad_angles` at
// status='proposed' with a `metadata.mined_from` provenance object so Phase 3
// can trace each approved angle back to the exact rows that produced it.
// ─────────────────────────────────────────────────────────────────────────────

export interface PersistProposedAnglesOpts {
  workspaceId: string;
  productId: string;
  /** Verbatim from product_page_content.benefit_bar[].text OR product_benefit_selections.benefit_name — the schema requires it NOT NULL. */
  leadBenefitAnchor: string;
  /** Mined fragments — used to map each candidate's supporting_fragment_ids to per-source id arrays in metadata.mined_from. */
  fragments: VoiceFragment[];
  /** Scored candidates from `synthesizeAdAngles`. */
  candidates: AngleCandidate[];
}

export interface PersistProposedAnglesResult {
  inserted: number;
  rows: Array<Record<string, unknown>>;
}

/**
 * Persist scored candidates as `product_ad_angles` rows at status='proposed'.
 * Each row carries `metadata.mined_from.{review_ids,cancel_event_ids,ticket_ids}`
 * derived from the candidate's supporting_fragment_ids — Phase 3 reads this
 * back when fanning approved angles into makers.
 *
 * Stays inside the existing schema: `hook_one_liner` gets the candidate's hook
 * (capped at 15 words on the input side by the LLM prompt), `proof_anchor`
 * gets a stat-typed wrapper around the candidate's proof string, and
 * mechanism_claim/offer ride along in `metadata` so no claim is silently lost.
 */
export function buildProposedAngleRows(
  opts: PersistProposedAnglesOpts,
): Array<Record<string, unknown>> {
  const fragById = new Map(opts.fragments.map((f) => [f.source_id, f]));
  return opts.candidates.map((c) => {
    const review_ids: string[] = [];
    const cancel_event_ids: string[] = [];
    const ticket_ids: string[] = [];
    for (const id of c.supporting_fragment_ids) {
      const f = fragById.get(id);
      if (!f) continue;
      if (f.source === "product_reviews") review_ids.push(id);
      else if (f.source === "customer_events") cancel_event_ids.push(id);
      else if (f.source === "tickets") ticket_ids.push(id);
    }
    return {
      workspace_id: opts.workspaceId,
      product_id: opts.productId,
      // Voice-mined candidates don't pre-pick a hook formula — the synthesizer
      // emits free-form hooks against the cross-brand pattern matrix. Default
      // to the broadest LF8-agnostic slot; Phase 3 can re-classify on approval.
      hook_slug: "visual_shock",
      lf8_slot: 1,
      lead_benefit_anchor: opts.leadBenefitAnchor,
      hook_one_liner: c.hook.slice(0, 200),
      proof_anchor: { type: "stat", value: c.proof },
      urgency_lever: "none",
      vibe_tags: [],
      generated_by: "agent",
      status: "proposed",
      is_active: false,
      metadata: {
        mined_from: { review_ids, cancel_event_ids, ticket_ids },
        matrix_overlap: c.matrix_overlap,
        density: c.density,
        score: c.score,
        mechanism_claim: c.mechanism_claim,
        offer: c.offer,
      },
    };
  });
}

export async function persistProposedAngles(
  admin: Admin,
  opts: PersistProposedAnglesOpts,
): Promise<PersistProposedAnglesResult> {
  const rows = buildProposedAngleRows(opts);
  if (rows.length === 0) return { inserted: 0, rows };
  const { error } = await admin.from("product_ad_angles").insert(rows);
  if (error) throw new Error(`persist_proposed_angles_failed: ${error.message}`);
  return { inserted: rows.length, rows };
}
