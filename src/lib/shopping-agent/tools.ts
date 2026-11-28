/**
 * AI shopping-agent MCP tools (docs/brain/libraries/shopping-agent.md · Phase 2 + Phase 3).
 *
 * The read-only tool surface exposed by /api/mcp/[workspace] to ChatGPT / Claude / Grok. Every tool
 * declares `annotations.readOnlyHint: true` (build_cart is the one writer — readOnlyHint:false,
 * destructiveHint:false). EVERY string a tool returns is passed through the compliance module
 * (src/lib/shopping-agent/compliance.ts) before it leaves the server: a blocked quote is dropped
 * whole, a blocked generated sentence is dropped and counted. The mandatory FDA disclaimer rides on
 * every product payload.
 *
 * Claim sources are fixed (the server never composes new health claims): benefit text from
 * product_benefit_selections + published product_page_content; quotes only from compliance_ok
 * customer situations / best-reviews; supplement facts ONLY from product_variants.supplement_facts
 * (never PDP copy — the live FAQ was found wrong on Berry caffeine); policy answers only via
 * getPolicyCustomerFacing.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getProductIntelligence, type ProductIntelligence } from "@/lib/product-intelligence";
import { retrieveContext } from "@/lib/rag";
import { getPolicyCustomerFacing } from "@/lib/policies";
import { listSituations, type CustomerSituationRow } from "@/lib/customer-situations";
import { formatSupplementFactsText, type SupplementFactsShape } from "@/lib/product-intelligence/publish";
import {
  checkClaim,
  filterText,
  filterQuotes,
  evaluateSafetyGate,
  MANDATORY_DISCLAIMER,
} from "./compliance";
import { buildCartForAgent, listFlavors, type AiAgentPlatform } from "./cart";

type Admin = ReturnType<typeof createAdminClient>;

/** Per-request context threaded through every handler. `blocked.count` tallies dropped claims. */
export interface ToolContext {
  admin: Admin;
  workspaceId: string;
  /** The AI app (chatgpt/claude/grok/other) — used for cart UTM tagging. */
  platform: AiAgentPlatform;
  /** Mutable per-request blocked-claim counter (fed to the supervision log). */
  blocked: { count: number };
  /** Product ids surfaced by this call (fed to the supervision log). */
  productIds: Set<string>;
}

/** Keep a single string only if it passes the block list; otherwise drop + count. */
function compliantField(ctx: ToolContext, text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (checkClaim(t).ok) return t;
  ctx.blocked.count += 1;
  return "";
}

/** Filter a composed paragraph sentence-by-sentence; add drops to the blocked counter. */
function compliantParagraph(ctx: ToolContext, text: string | null | undefined): string {
  const { text: kept, droppedCount } = filterText(text ?? "");
  ctx.blocked.count += droppedCount;
  return kept;
}

/** "Mindy Smith" → "Mindy S." ; already-abbreviated names pass through. */
function reviewerShortName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "A customer";
  const parts = n.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const initial = last.replace(/[^A-Za-z]/g, "").charAt(0).toUpperCase();
  return initial ? `${parts[0]} ${initial}.` : parts[0];
}

/** Format cents → "$1.50". */
function money(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

/** Pull caffeine (mg) out of a variant's supplement facts — stated whenever a caffeinated product shows. */
function extractCaffeine(facts: SupplementFactsShape | null | undefined): string | null {
  if (!facts) return null;
  const n = (facts.nutrients ?? []).find((x) => x.name?.toLowerCase().includes("caffeine"));
  if (n?.amount) return n.amount;
  const blend = facts.proprietary_blend?.ingredients ?? "";
  // A blend can carry several caffeine sources, e.g. Amazing Coffee = "French roast coffee (60 mg
  // caffeine) ... Caffeine anhydrous (105 mg caffeine)" → 165 mg. Sum them; never report just the first.
  const sources = [...blend.matchAll(/(\d+(?:\.\d+)?)\s*mg\s*caffeine/gi)].map((x) => Number(x[1]));
  if (sources.length) return `${sources.reduce((a, b) => a + b, 0)} mg`;
  const m = blend.match(/caffeine[^)]*?(\d+\s*mg)/i);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------------------------------------
 * Product-card builder — the compliant, shared shape returned by search / compare / situation.
 * --------------------------------------------------------------------------------------------- */

export interface ProductCard {
  product_id: string;
  title: string;
  handle: string | null;
  image: string | null;
  rating: number | null;
  review_count: number;
  lead_benefit: string;
  price_per_serving: string | null;
  offer: string;
  caffeine: string | null;
  disclaimer: string;
}

function leadBenefitText(ctx: ToolContext, pi: ProductIntelligence): string {
  const lead = pi.benefits.find((b) => (b as { role?: string }).role === "lead")
    ?? pi.benefits.find((b) => (b as { role?: string }).role === "supporting");
  return compliantField(ctx, (lead as { benefit_name?: string } | undefined)?.benefit_name ?? "");
}

function caffeineForProduct(pi: ProductIntelligence): string | null {
  for (const v of pi.variants) {
    const c = extractCaffeine((v as { supplement_facts?: SupplementFactsShape | null }).supplement_facts);
    if (c) return c;
  }
  return null;
}

function toCard(ctx: ToolContext, pi: ProductIntelligence): ProductCard | null {
  const p = pi.product as { id?: string; title?: string; handle?: string; image_url?: string; rating?: number } | null;
  if (!p?.id) return null;
  ctx.productIds.add(p.id);
  return {
    product_id: p.id,
    title: p.title ?? "",
    handle: p.handle ?? null,
    image: p.image_url ?? null,
    rating: p.rating ?? null,
    review_count: pi.reviews.totalCount,
    lead_benefit: leadBenefitText(ctx, pi),
    price_per_serving: money(pi.offer?.perServingCents ?? null),
    offer: compliantField(ctx, pi.offer?.headline ?? ""),
    caffeine: caffeineForProduct(pi),
    disclaimer: MANDATORY_DISCLAIMER,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Product resolution + active listing.
 * --------------------------------------------------------------------------------------------- */

interface ActiveProductRow {
  id: string;
  title: string | null;
  handle: string | null;
  product_type: string | null;
  tags: string[] | null;
  description: string | null;
  is_advertised: boolean | null;
}

/** Words a shopper might type that never identify a product on their own. */
const QUERY_STOPWORDS = new Set(["the", "and", "for", "with", "best", "your", "superfoods", "company", "product", "products"]);

/** Score a product row against the shopper's query words (title/handle weigh most). 0 = no match. */
export function productQueryScore(row: Pick<ActiveProductRow, "title" | "handle" | "product_type" | "tags" | "description">, query: string): number {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !QUERY_STOPWORDS.has(w));
  if (!words.length) return 0;
  const name = `${row.title ?? ""} ${row.handle ?? ""}`.toLowerCase();
  const meta = `${row.product_type ?? ""} ${(row.tags ?? []).join(" ")}`.toLowerCase();
  const desc = (row.description ?? "").toLowerCase();
  let score = 0;
  for (const w of words) {
    if (name.includes(w)) score += 3;
    else if (meta.includes(w)) score += 2;
    else if (desc.includes(w)) score += 1;
  }
  return score;
}

/**
 * Active, sellable products for the agent. Add-ons the customer never chose on their own
 * (Shipping Protection, reviewable=false) are excluded at the query; accessories with no product
 * intelligence are dropped later by `hasIntelligence`. Advertised hero SKUs sort first. With a
 * `query`, only matching products are returned (best match first).
 */
async function listActiveProducts(ctx: ToolContext, limit = 12, query = ""): Promise<string[]> {
  const { data } = await ctx.admin
    .from("products")
    .select("id, title, handle, product_type, tags, description, is_advertised")
    .eq("workspace_id", ctx.workspaceId)
    .eq("status", "active")
    .eq("reviewable", true)
    .limit(200);
  let rows = ((data ?? []) as ActiveProductRow[]).filter((r) => !/shipping protection|shipping insurance/i.test(r.title ?? ""));
  if (query.trim()) {
    rows = rows
      .map((r) => ({ r, score: productQueryScore(r, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || Number(!!b.r.is_advertised) - Number(!!a.r.is_advertised))
      .map((x) => x.r);
  } else {
    rows = rows.sort((a, b) => Number(!!b.is_advertised) - Number(!!a.is_advertised));
  }
  return rows.slice(0, limit).map((r) => r.id);
}

/** A product the agent can actually talk about: it has curated benefits or ingredients on file. */
function hasIntelligence(pi: ProductIntelligence): boolean {
  return pi.benefits.length > 0 || pi.ingredients.length > 0;
}

async function resolveProductId(ctx: ToolContext, idOrHandle: string): Promise<string | null> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrHandle)) return idOrHandle;
  const { data } = await ctx.admin
    .from("products")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("handle", idOrHandle)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/* ------------------------------------------------------------------------------------------------
 * Tool handlers.
 * --------------------------------------------------------------------------------------------- */

async function searchProducts(ctx: ToolContext, args: { query?: string }): Promise<unknown> {
  const query = String(args.query ?? "").slice(0, 200);
  let ids = await listActiveProducts(ctx, 12, query);
  // Nothing matched the words → show the full lineup rather than an empty shelf.
  const matched = !query.trim() || ids.length > 0;
  if (!matched) ids = await listActiveProducts(ctx, 12);
  const intel = await Promise.all(ids.map((id) => getProductIntelligence(ctx.admin, ctx.workspaceId, id)));
  const cards: ProductCard[] = [];
  for (const pi of intel) {
    if (!hasIntelligence(pi)) continue;
    const card = toCard(ctx, pi);
    if (card) cards.push(card);
  }
  return {
    products: cards,
    ...(matched ? {} : { note: `No product matched "${query}", so this is the full lineup.` }),
    disclaimer: MANDATORY_DISCLAIMER,
  };
}

/** Naive keyword overlap score between the shopper's words and a situation row's text. */
function situationScore(situation: CustomerSituationRow, words: string[]): number {
  const hay = [situation.situation, situation.who, situation.goal, situation.noticed, situation.slug]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const w of words) if (w.length >= 4 && hay.includes(w)) score += 1;
  return score;
}

async function findProductsForSituation(ctx: ToolContext, args: { situation?: string }): Promise<unknown> {
  const situationText = String(args.situation ?? "").slice(0, 2000);

  // Input-side SAFETY GATE — pregnancy/nursing/medication/under-18/medical/disease term.
  const gate = evaluateSafetyGate(situationText);
  if (gate.triggered) {
    // Return the doctor note + contraindications; NO recommendation, NO quote.
    const ids = await listActiveProducts(ctx, 6);
    const contraindications: string[] = [];
    let caffeineNote: string | null = null;
    for (const id of ids) {
      const pi = await getProductIntelligence(ctx.admin, ctx.workspaceId, id);
      for (const r of pi.ingredientResearch) {
        const c = compliantField(ctx, (r as { contraindications?: string }).contraindications ?? "");
        if (c) contraindications.push(c);
      }
      caffeineNote = caffeineNote ?? caffeineForProduct(pi);
    }
    return {
      safety_note: gate.note,
      recommendation: null,
      contraindications: [...new Set(contraindications)].slice(0, 8),
      caffeine: caffeineNote,
      disclaimer: MANDATORY_DISCLAIMER,
    };
  }

  const words = situationText.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const situations = await listSituations(ctx.admin, ctx.workspaceId, { compliantOnly: true, limit: 200 });
  const ranked = situations
    .map((s) => ({ s, score: situationScore(s, words) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const matches = [];
  for (const { s } of ranked) {
    ctx.productIds.add(s.product_id);
    const { kept } = filterQuotes(s.quotes); // compliant quotes only; already compliance_ok
    const quotes = kept.slice(0, 2).map((q) => ({
      quote: q.verbatim_phrase,
      reviewer: reviewerShortName(q.reviewer),
      rating: q.rating,
    }));
    const pi = await getProductIntelligence(ctx.admin, ctx.workspaceId, s.product_id);
    matches.push({
      situation: compliantField(ctx, s.situation),
      who: compliantField(ctx, s.who),
      noticed: compliantField(ctx, s.noticed),
      quotes,
      product: toCard(ctx, pi),
    });
  }
  return { matches, disclaimer: MANDATORY_DISCLAIMER };
}

async function getProductDetails(ctx: ToolContext, args: { product_id?: string; handle?: string }): Promise<unknown> {
  const key = String(args.product_id ?? args.handle ?? "");
  const id = key ? await resolveProductId(ctx, key) : null;
  if (!id) return { error: "product not found" };
  const pi = await getProductIntelligence(ctx.admin, ctx.workspaceId, id);
  ctx.productIds.add(id);

  const ingredients = pi.ingredients.map((i) => {
    const row = i as { name?: string; dosage_display?: string; dosage_mg?: number };
    return { name: row.name ?? "", dose: row.dosage_display ?? (row.dosage_mg != null ? `${row.dosage_mg} mg` : null) };
  });

  // Supplement facts quoted ONLY from product_variants.supplement_facts — never PDP copy.
  const supplementFacts: string[] = [];
  for (const v of pi.variants) {
    const txt = formatSupplementFactsText((v as { supplement_facts?: SupplementFactsShape | null }).supplement_facts);
    if (txt) supplementFacts.push(txt);
  }

  const pc = (pi.pageContent ?? {}) as Record<string, unknown>;
  const contraindications = [
    ...new Set(
      pi.ingredientResearch
        .map((r) => compliantField(ctx, (r as { contraindications?: string }).contraindications ?? ""))
        .filter(Boolean),
    ),
  ];

  // Selling points = the curated benefit spine (product_benefit_selections), lead first, each with
  // up to 3 compliant customer phrases. Never composed here.
  const rolePriority = (r: string | undefined) => (r === "lead" ? 0 : r === "supporting" ? 1 : 2);
  const sellingPoints = [...pi.benefits]
    .map((b) => b as { benefit_name?: string; role?: string; display_order?: number; customer_phrases?: string[] | null })
    .sort((a, b) => rolePriority(a.role) - rolePriority(b.role) || (a.display_order ?? 0) - (b.display_order ?? 0))
    .map((b) => ({
      benefit: compliantField(ctx, b.benefit_name ?? ""),
      role: b.role ?? null,
      customers_say: (b.customer_phrases ?? []).map((p) => compliantField(ctx, p)).filter(Boolean).slice(0, 3),
    }))
    .filter((b) => b.benefit);

  // The PDP expectation timeline is marketing copy: screen every headline/body like any other text.
  const timeline = (Array.isArray(pc.expectation_timeline) ? pc.expectation_timeline : [])
    .map((t) => t as { time_label?: string; headline?: string; body?: string })
    .map((t) => ({
      time_label: t.time_label ?? "",
      headline: compliantField(ctx, t.headline ?? ""),
      body: compliantParagraph(ctx, t.body ?? ""),
    }))
    .filter((t) => t.body);

  const product = pi.product as { title?: string; target_customer?: string | null } | null;
  return {
    product_id: id,
    title: product?.title ?? "",
    selling_points: sellingPoints,
    who_its_for: compliantField(ctx, product?.target_customer ?? ""),
    ingredients,
    supplement_facts: supplementFacts,
    caffeine: caffeineForProduct(pi),
    how_to_use: compliantParagraph(ctx, String(pc.mechanism_copy ?? pc.how_to_use ?? "")),
    expectation_timeline: timeline,
    guarantee: compliantParagraph(ctx, String(pc.guarantee_copy ?? "")),
    contraindications,
    disclaimer: MANDATORY_DISCLAIMER,
  };
}

async function answerProductQuestion(
  ctx: ToolContext,
  args: { question?: string; product_id?: string },
): Promise<unknown> {
  const question = String(args.question ?? "").slice(0, 2000);

  // Safety-sensitive question → doctor note, no composed health answer.
  const gate = evaluateSafetyGate(question);
  if (gate.triggered) {
    return { answer: gate.note, source: "safety_gate", disclaimer: MANDATORY_DISCLAIMER };
  }

  // Policy question → customer-facing policy text ONLY (never internal_summary/rules).
  const policySlug = /ship|deliver/i.test(question)
    ? "shipping"
    : /refund|return|money.?back|guarantee/i.test(question)
      ? "returns"
      : /cancel|subscription/i.test(question)
        ? "cancellation"
        : null;
  if (policySlug) {
    const policy = await getPolicyCustomerFacing(ctx.admin, ctx.workspaceId, policySlug);
    if (policy) {
      return {
        answer: policy.customer_summary,
        source: `policy:${policy.slug}`,
        label: "This is our published policy.",
        disclaimer: MANDATORY_DISCLAIMER,
      };
    }
  }

  // RAG over kb_chunks + published faq_items + ingredient research.
  const rag = await retrieveContext(ctx.workspaceId, question, 8);
  const faqAnswers: string[] = [];
  if (args.product_id) {
    const id = await resolveProductId(ctx, String(args.product_id));
    if (id) {
      const pi = await getProductIntelligence(ctx.admin, ctx.workspaceId, id);
      ctx.productIds.add(id);
      const faqs = (((pi.pageContent ?? {}) as Record<string, unknown>).faq_items ?? []) as Array<{ question: string; answer: string }>;
      for (const f of faqs) {
        if (question.toLowerCase().split(/\W+/).some((w) => w.length >= 4 && f.question?.toLowerCase().includes(w))) {
          faqAnswers.push(f.answer);
        }
      }
    }
  }
  const raw = [...faqAnswers, ...rag.chunks.map((c) => c.chunk_text)].join(" ");
  const answer = compliantParagraph(ctx, raw);
  return {
    answer: answer || "I don't have a verified answer for that — please contact support.",
    source: "knowledge_base",
    disclaimer: MANDATORY_DISCLAIMER,
  };
}

async function getReviews(ctx: ToolContext, args: { product_id?: string; handle?: string; topic?: string }): Promise<unknown> {
  const key = String(args.product_id ?? args.handle ?? "");
  const id = key ? await resolveProductId(ctx, key) : null;
  if (!id) return { error: "product not found" };
  const pi = await getProductIntelligence(ctx.admin, ctx.workspaceId, id);
  ctx.productIds.add(id);
  const topic = String(args.topic ?? "").toLowerCase().trim();

  const candidate = [...pi.reviews.featured, ...pi.reviews.recentFiveStar];
  const seen = new Set<string>();
  const compliant = filterQuotes(
    candidate
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
      .map((r) => ({ verbatim_phrase: r.smart_quote || r.summary || r.body || "", reviewer: r.reviewer_name, rating: r.rating })),
  ).kept;

  const filtered = topic
    ? compliant.filter((r) => r.verbatim_phrase.toLowerCase().includes(topic))
    : compliant;

  return {
    reviews: filtered.slice(0, 8).map((r) => ({
      quote: r.verbatim_phrase,
      reviewer: reviewerShortName(r.reviewer),
      rating: r.rating,
    })),
    disclaimer: MANDATORY_DISCLAIMER,
  };
}

async function compareProducts(ctx: ToolContext, args: { product_ids?: string[]; handles?: string[] }): Promise<unknown> {
  const keys = [...(args.product_ids ?? []), ...(args.handles ?? [])].slice(0, 4);
  const cards: ProductCard[] = [];
  for (const k of keys) {
    const id = await resolveProductId(ctx, String(k));
    if (!id) continue;
    const pi = await getProductIntelligence(ctx.admin, ctx.workspaceId, id);
    const card = toCard(ctx, pi);
    if (card) cards.push(card);
  }
  return { products: cards, disclaimer: MANDATORY_DISCLAIMER };
}

/* ------------------------------------------------------------------------------------------------
 * build_cart (Phase 3) — the ONE writer. readOnlyHint:false, destructiveHint:false.
 * --------------------------------------------------------------------------------------------- */

async function buildCart(
  ctx: ToolContext,
  args: { product_id?: string; handle?: string; pack_tier?: number; flavor?: string; mode?: string; frequency_days?: number },
): Promise<unknown> {
  const key = String(args.product_id ?? args.handle ?? "");
  const id = key ? await resolveProductId(ctx, key) : null;
  if (!id) return { error: "product not found" };
  ctx.productIds.add(id);
  const result = await buildCartForAgent(ctx.admin, ctx.workspaceId, {
    productId: id,
    packTier: Math.max(1, Number(args.pack_tier ?? 1)),
    flavor: typeof args.flavor === "string" ? args.flavor : null,
    mode: args.mode === "subscribe" ? "subscribe" : "onetime",
    frequencyDays: args.frequency_days ?? null,
    platform: ctx.platform,
  });
  const flavors = await listFlavors(ctx.admin, ctx.workspaceId, id);
  return { ...result, available_flavors: flavors, disclaimer: MANDATORY_DISCLAIMER };
}

/* ------------------------------------------------------------------------------------------------
 * Tool registry.
 * --------------------------------------------------------------------------------------------- */

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  /** MCP Apps UI resource backing this tool's render (Phase 3). */
  uiResourceUri?: string;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}


export const SHOPPING_AGENT_TOOLS: McpToolDef[] = [
  {
    name: "search_products",
    title: "Search products",
    description: "Find the store's products by name or keyword (e.g. coffee, creamer, tabs), with rating, review count, lead benefit, price per serving and caffeine. Omit query for the full lineup.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Product name or keyword. Omit to list everything." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    uiResourceUri: "ui://shopping-agent/product-card.html",
    handler: (ctx, args) => searchProducts(ctx, args as { query?: string }),
  },
  {
    name: "find_products_for_situation",
    title: "Find products for your situation",
    description: "Describe your situation in your own words; get the products that fit, what customers in the same situation noticed, and 1-2 verified quotes.",
    inputSchema: {
      type: "object",
      properties: { situation: { type: "string", description: "The shopper's situation, in their words." } },
      required: ["situation"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    uiResourceUri: "ui://shopping-agent/product-card.html",
    handler: (ctx, args) => findProductsForSituation(ctx, args as { situation?: string }),
  },
  {
    name: "get_product_details",
    title: "Get product details",
    description: "Selling points (curated benefits with what customers say), who it's for, ingredients + doses, supplement facts, how it works, expectation timeline, guarantee and contraindications for one product.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string" }, handle: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: (ctx, args) => getProductDetails(ctx, args as { product_id?: string; handle?: string }),
  },
  {
    name: "answer_product_question",
    title: "Answer a product question",
    description: "Answer a question about a product or a store policy from verified knowledge only.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" }, product_id: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: (ctx, args) => answerProductQuestion(ctx, args as { question?: string; product_id?: string }),
  },
  {
    name: "get_reviews",
    title: "Get reviews",
    description: "The best customer reviews for a product, optionally filtered by topic.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string" }, handle: { type: "string" }, topic: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: (ctx, args) => getReviews(ctx, args as { product_id?: string; handle?: string; topic?: string }),
  },
  {
    name: "compare_products",
    title: "Compare products",
    description: "Compare two to four products side by side.",
    inputSchema: {
      type: "object",
      properties: {
        product_ids: { type: "array", items: { type: "string" } },
        handles: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: (ctx, args) => compareProducts(ctx, args as { product_ids?: string[]; handles?: string[] }),
  },
  {
    name: "build_cart",
    title: "Build a cart",
    description: "Create a cart for a product + pack tier and get a secure checkout link to finish on our store.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        handle: { type: "string" },
        pack_tier: { type: "number", description: "Quantity of units (1, 2, 3+)." },
        flavor: { type: "string", description: "The flavor or option the shopper wants (e.g. Berry). Omit to use the default; the result lists available_flavors." },
        mode: { type: "string", enum: ["subscribe", "onetime"] },
        frequency_days: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    uiResourceUri: "ui://shopping-agent/pack-picker.html",
    handler: (ctx, args) => buildCart(ctx, args as Record<string, unknown>),
  },
];

export const TOOLS_BY_NAME: Map<string, McpToolDef> = new Map(SHOPPING_AGENT_TOOLS.map((t) => [t.name, t]));
