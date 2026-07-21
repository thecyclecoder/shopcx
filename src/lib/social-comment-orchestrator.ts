/**
 * Two-pass Meta-comments moderator.
 *
 *   ─── PASS 1 — Haiku (claude-haiku-4-5) ───
 *   Cheap, fast triage. Classifies the comment into one of:
 *     - clean       → pass through to Pass 2
 *     - spam        → auto: hide
 *     - sexual      → auto: delete + ban
 *     - abusive     → auto: delete + ban
 *     - irrelevant  → auto: ignore
 *   Pass 1 NEVER drafts a reply — that's Opus's job.
 *
 *   ─── PASS 2 — Opus 4.7 (claude-opus-4-7) ───
 *   Only runs on "clean" comments. Full context + KB + macros + sender
 *   history. Considers the reply through three lenses:
 *     - helpfulness for the commenter
 *     - public impact (how does this read to other browsers?)
 *     - sales consideration (does this build social proof / drive intent?)
 *   Decides:
 *     - action: reply | hidden_reply | like | escalate | ignore
 *     - visibility: 'public' | 'hidden' (only relevant when reply-ish)
 *     - reply_body: actual draft
 *     - considers: structured reasoning for review
 *     - kb_sources: which articles/macros informed it
 *
 *   ─── ModerationDecision contract ───
 *   Both passes converge on the same output shape so applyModerationDecision
 *   doesn't care which pass produced it. Pass 1 short-circuits with the
 *   non-clean classifications; Pass 2 fills in everything else.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { retrieveContext } from "@/lib/rag";
import { logAiUsage, type ClaudeUsage } from "@/lib/ai-usage";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const OPUS_MODEL = "claude-opus-4-7";
type Admin = ReturnType<typeof createAdminClient>;

export type ModerationAction =
  | "reply"
  | "hidden_reply"   // NEW: hide the comment then reply on the hidden thread
  | "like"
  | "hide"
  | "delete"
  | "ignore"
  | "escalate";

export type ModerationSentiment =
  | "positive"
  | "negative"
  | "neutral"
  | "spam"
  | "abusive";

export interface ModerationConsiders {
  helpfulness?: string;
  public_impact?: string;
  sales_consideration?: string;
}

export interface ModerationDecision {
  reasoning: string;
  action: ModerationAction;
  reply_body: string | null;
  sentiment: ModerationSentiment;
  ban_user: boolean;
  ban_reason: string | null;
  visibility: "public" | "hidden" | null;
  considers: ModerationConsiders | null;
  kb_sources: string[];
  model: string;
}

const FALLBACK_DECISION: ModerationDecision = {
  reasoning: "Orchestrator error — escalating to a human moderator",
  action: "escalate",
  reply_body: null,
  sentiment: "neutral",
  ban_user: false,
  ban_reason: null,
  visibility: null,
  considers: null,
  kb_sources: [],
  model: "fallback",
};

interface CommentContext {
  workspaceId: string;
  socialCommentId: string;
  comment: {
    body: string;
    sender_name: string | null;
    sender_username: string | null;
    sender_id: string;
    is_ad: boolean;
    page_type: string;
    matched_product_id: string | null;
  };
  page: { name: string | null; type: string; platform: string };
  post: { permalink_url: string | null; message: string | null; is_ad: boolean } | null;
  matchedProduct: { title: string; description: string | null; url: string | null } | null;
  /** Workspace-curated proof points (money-back guarantee, customer
   *  count, science backing, etc.) the AI weaves into public replies
   *  when a commenter raises a price/affordability objection. */
  brandProofPoints: string | null;
  /** Workspace-curated competitor brand/product names (one per line).
   *  When Pass-1 detects positive promotion of one of these on our
   *  paid creative, classify as competitor_promotion → delete + ban. */
  competitorKeywords: string | null;
  /** Optional hint from an agent triggering a re-moderation, e.g.
   *  "this is actually a glowing review, not spam". Overrides both
   *  passes' default classifications when supplied. */
  humanHint: string | null;
  /** Active crisis affecting the matched product — drives "back in
   *  stock by July 9" style replies when commenters ask about it.
   *  Null when there's no crisis touching the matched product. */
  crisis: {
    name: string;
    affected_product_title: string;
    expected_restock_date: string | null;
  } | null;
}

// ────────────────────────────────────────────────────────────────────────
// PASS 1 — Haiku triage
// ────────────────────────────────────────────────────────────────────────

type Pass1Classification = "clean" | "spam" | "sexual" | "abusive" | "irrelevant" | "competitor_promotion";

interface Pass1Output {
  classification: Pass1Classification;
  sentiment: ModerationSentiment;
  reasoning: string;
}

function buildPass1Prompt(ctx: CommentContext): string {
  const lines: string[] = [];
  lines.push("You are the FIRST PASS of a two-stage comment moderator. Your only job is fast triage.");
  lines.push("");
  lines.push(`COMMENT: ${ctx.comment.body.slice(0, 1000)}`);
  lines.push(`From: ${ctx.comment.sender_name || "(unknown)"}${ctx.comment.sender_username ? ` (@${ctx.comment.sender_username})` : ""}`);
  lines.push(`On ${ctx.comment.is_ad ? "an AD" : "an ORGANIC POST"} for "${ctx.page.name || "(page)"}" (${ctx.page.platform})`);
  if (ctx.post?.message) lines.push(`Post caption: ${ctx.post.message.slice(0, 200)}`);
  if (ctx.humanHint) {
    lines.push("");
    lines.push(`AGENT HINT (trusted operator who re-triggered this moderation): ${ctx.humanHint}`);
    lines.push("Use the agent's framing to inform your classification. If they say the comment is a real customer / glowing review / sincere complaint, trust that over surface heuristics like 'short emoji-heavy text looks like spam'.");
  }
  lines.push("");
  lines.push("Classify into EXACTLY ONE category:");
  lines.push("  - spam: link spam, contact-info dumps, fake promo codes, repeated promotional content unrelated to our brand");
  lines.push("  - sexual: sexual harassment, soliciting, lewd content");
  lines.push("  - abusive: slurs, doxxing, targeted hate, threats — AND brand-attack/anti-campaign comments. Anti-campaign means comments whose primary intent is to discourage others from buying or to publicly broadcast a grievance as a warning: 'don't buy from this company', 'this is a scam', 'they ripped me off', 'beware of these people', 'tag everyone you know so they don't get scammed', etc. These are usually people who got a denied refund or had a bad experience and are trying to damage the brand. A single complaint or negative review of the product is CLEAN, not abusive. Anti-campaign requires the intent to recruit OTHER customers against the brand.");
  lines.push("  - competitor_promotion: comment endorses, recommends, or actively shills a competitor brand/product under OUR paid ad. The intent matters — not the mere mention. POSITIVE PROMOTION ('I drink Ryze daily', 'try AG1 instead, way better', 'Mud\\Wtr changed my life, switch to that') → competitor_promotion. NEUTRAL PRICE COMPARISON ('twice the price of Ryze', 'cheaper than Athletic Greens') is NOT competitor_promotion — that's a price objection mentioning a competitor as context and stays CLEAN so Pass-2 can handle it as an objection. Naming a competitor as part of a complaint about us is also clean. The bar: is the commenter trying to redirect prospects to a competitor? If yes, competitor_promotion. If they're just expressing skepticism or context, clean.");
  lines.push("  - irrelevant: tagging unrelated users with no comment, single emoji with no signal, gibberish");
  lines.push("  - clean: anything else, INCLUDING negative complaints, criticism, sarcasm, or off-color humor that's not crossing a line. Real customer feedback — even harsh — is clean. Asking for a refund publicly is clean. Saying 'I had a bad experience' is clean. Mentioning a competitor in a price comparison or skeptical context is clean. The line is when the comment shifts from sharing experience to actively trying to dissuade others or promote a competitor.");
  if (ctx.competitorKeywords) {
    lines.push("");
    lines.push("KNOWN COMPETITORS for this workspace (mentions to evaluate carefully):");
    lines.push(ctx.competitorKeywords);
  }
  lines.push("");
  lines.push("Also assign a sentiment: positive / negative / neutral / spam / abusive.");
  lines.push("Sentiment is independent of classification — a 'clean' comment can be negative; a positive comment is never abusive.");
  lines.push("");
  lines.push("Respond with ONLY valid JSON, no prose:");
  lines.push("{");
  lines.push('  "classification": "clean" | "spam" | "sexual" | "abusive" | "competitor_promotion" | "irrelevant",');
  lines.push('  "sentiment": "positive" | "negative" | "neutral" | "spam" | "abusive",');
  lines.push('  "reasoning": "one short sentence"');
  lines.push("}");
  return lines.join("\n");
}

async function runPass1(apiKey: string, ctx: CommentContext, logUsage: (u: ClaudeUsage | undefined, tag: string) => void): Promise<Pass1Output | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: buildPass1Prompt(ctx) }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  logUsage(data.usage, "pass1-haiku");
  const text = (data.content?.[0]?.text || "") as string;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return {
      classification: parsed.classification as Pass1Classification,
      sentiment: (parsed.sentiment as ModerationSentiment) || "neutral",
      reasoning: String(parsed.reasoning || ""),
    };
  } catch { return null; }
}

function pass1ToDecision(p1: Pass1Output): ModerationDecision {
  const base: ModerationDecision = {
    reasoning: `[Pass 1 — ${p1.classification}] ${p1.reasoning}`,
    action: "escalate",
    reply_body: null,
    sentiment: p1.sentiment,
    ban_user: false,
    ban_reason: null,
    visibility: null,
    considers: null,
    kb_sources: [],
    model: HAIKU_MODEL,
  };
  switch (p1.classification) {
    case "spam":
      return { ...base, action: "delete", ban_user: true, ban_reason: "spam" };
    case "sexual":
      return { ...base, action: "delete", ban_user: true, ban_reason: "sexual content" };
    case "abusive":
      return { ...base, action: "delete", ban_user: true, ban_reason: "abusive content" };
    case "competitor_promotion":
      return { ...base, action: "delete", ban_user: true, ban_reason: "competitor promotion" };
    case "irrelevant":
      return { ...base, action: "ignore" };
    case "clean":
      // Should not be called — clean cases go to Pass 2
      return { ...base, action: "escalate", reasoning: "Pass 1 classified clean — Pass 2 failed to run" };
  }
}

/**
 * Short-circuit pre-check: if this sender is already banned in the
 * workspace (any page), auto-delete + re-ban on the current page
 * without running either pass. Bans on Meta are per-Page; our
 * banned_meta_users row is the workspace-wide flag — when this user
 * shows up on a new page we recognize them immediately.
 */
async function checkPreviouslyBanned(
  admin: Admin,
  workspaceId: string,
  senderId: string,
): Promise<ModerationDecision | null> {
  const { data } = await admin
    .from("banned_meta_users")
    .select("reason, banned_at")
    .eq("workspace_id", workspaceId)
    .eq("meta_sender_id", senderId)
    .is("unbanned_at", null)
    .maybeSingle();
  if (!data) return null;
  return {
    reasoning: `Previously banned in this workspace (${data.reason || "no reason given"}). Auto-deleting + extending ban to this page.`,
    action: "delete",
    reply_body: null,
    sentiment: "abusive",
    ban_user: true,
    ban_reason: data.reason || "previously banned",
    visibility: null,
    considers: null,
    kb_sources: [],
    model: "pre_check",
  };
}

// ────────────────────────────────────────────────────────────────────────
// PASS 2 — Opus deep reasoning
// ────────────────────────────────────────────────────────────────────────

async function gatherPass2RagContext(
  admin: Admin,
  ctx: CommentContext,
): Promise<{ ragText: string; sources: string[] }> {
  // Search KB + macros against the comment body, biased by post caption
  // + matched product title for better recall on short comments.
  const query = [
    ctx.comment.body.slice(0, 300),
    ctx.matchedProduct?.title || "",
    ctx.post?.message?.slice(0, 200) || "",
  ].filter(Boolean).join(" ");

  const rag = await retrieveContext(ctx.workspaceId, query, 8);
  const sources: string[] = [];
  const parts: string[] = [];
  if (rag.macros?.length) {
    parts.push("RELEVANT MACROS (use these as voice/structure templates):");
    for (const m of rag.macros) {
      const body = (m.body_text || m.body_html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      parts.push(`  • [${m.name}] ${body.slice(0, 400)}`);
      sources.push(`macro:${m.name}`);
    }
  }
  if (rag.chunks?.length) {
    parts.push("\nKNOWLEDGE BASE EXCERPTS (use for facts):");
    for (const c of rag.chunks) {
      const body = (c.chunk_text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      parts.push(`  • [${c.kb_title || "Article"}] ${body.slice(0, 400)}`);
      if (c.kb_title) sources.push(`kb:${c.kb_title}`);
    }
  }
  return { ragText: parts.join("\n") || "(no relevant KB or macros)", sources };
}

async function getBrandPolicies(admin: Admin, workspaceId: string): Promise<string> {
  const { data: prompts } = await admin
    .from("sonnet_prompts")
    .select("title, content, category")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .eq("status", "approved")
    .ilike("title", "social%")
    .order("category").order("sort_order");
  if (!prompts?.length) return "No workspace-specific moderation policies configured.";
  return "POLICIES:\n" + prompts.map(p => `[${p.category}] ${p.content}`).join("\n");
}

async function getSenderHistory(admin: Admin, workspaceId: string, senderId: string, exceptId: string): Promise<string> {
  const { data: history } = await admin
    .from("social_comments")
    .select("body, status, sentiment, created_at")
    .eq("workspace_id", workspaceId).eq("meta_sender_id", senderId).neq("id", exceptId)
    .order("created_at", { ascending: false }).limit(8);
  if (!history?.length) return "No prior comments from this sender.";
  return "PRIOR COMMENTS FROM THIS SENDER:\n" + history.map(h => {
    const date = new Date(h.created_at as string).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `  • ${date} | ${h.status}${h.sentiment ? ` (${h.sentiment})` : ""}: ${(h.body as string || "").slice(0, 120)}`;
  }).join("\n");
}

function buildPass2Prompt(ctx: CommentContext, rag: string, policies: string, senderHistory: string): string {
  const lines: string[] = [];
  lines.push(`You are the SECOND PASS — a deep-reasoning moderator deciding what to do with a CLEAN public comment on a ${ctx.page.platform} ${ctx.comment.is_ad ? "ad" : "organic post"}.`);
  lines.push("");
  lines.push("This comment passed the Haiku spam/abuse triage. Your job is to:");
  lines.push("  1. Decide whether to reply, hidden-reply, like, ignore, or escalate to a human.");
  lines.push("  2. If you reply, draft an actual reply (no placeholders).");
  lines.push("  3. Reason explicitly about three lenses (commenter helpfulness, public impact, sales consideration).");
  lines.push("");
  lines.push("VISIBILITY — THE BIG DECISION:");
  lines.push("  - public  : reply is visible to everyone who scrolls the post. Use when the reply ALSO helps other readers, builds social proof, or moves a real customer concern toward resolution publicly.");
  lines.push("  - hidden  : hide the comment from public view, then reply on the hidden thread. Only the commenter sees it. Use when the topic is sensitive (delivery problem, refund, allergic reaction), when a public response would make us look bad even if accurate, or when the question is so individual it doesn't help other readers.");
  lines.push("  - For 'like' / 'ignore' / 'escalate', visibility = null.");
  lines.push("");
  lines.push("OBJECTION HANDLING — DO NOT HIDE THESE:");
  lines.push("  Price / affordability objections ('too expensive', 'can't afford', 'too pricey', 'out of my budget', 'why so much', 'pricing is crazy', etc.) are PUBLIC value-building opportunities, not embarrassments to hide. Hundreds of other scrollers see the same objection — your reply is for them as much as for the commenter.");
  lines.push("  Default: action='reply', visibility='public'.");
  lines.push("  Reply formula: (1) brief empathy, (2) 1-2 concrete proof points from BRAND PROOF POINTS below, (3) acknowledge that promos/bundles do bring the cost down (without promising a specific code). Keep it warm and short — 1-2 sentences. No defensiveness.");
  lines.push("  Skepticism about claims ('does this really work?', 'sounds too good') — also PUBLIC. Lean on proof points + reviews + the money-back guarantee.");
  lines.push("  Hide is for: refund disputes, delivery failures, allergic reactions, anything where the SPECIFIC FACTS being discussed publicly could backfire. Cost is never a hide reason.");
  lines.push("");
  lines.push("ACTIONS:");
  lines.push("  - reply        — public reply with reply_body. visibility = 'public'.");
  lines.push("  - hidden_reply — hide comment + reply on the hidden thread with reply_body. visibility = 'hidden'.");
  lines.push("  - like         — public positive comment that doesn't need words. visibility = null.");
  lines.push("  - ignore       — comment stays public but no action. visibility = null. Use sparingly.");
  lines.push("  - escalate     — a human should write this. visibility = null. Use when the comment touches: legal, medical claims, refund disputes, allergic reactions, or anything where getting it wrong publicly would matter.");
  lines.push("");
  lines.push("REPLY VOICE:");
  lines.push("  - Short. Mirror the commenter's tone. No markdown. No emoji unless they used one first.");
  lines.push("  - Use the macros below as voice/structure templates — match length and warmth, don't copy verbatim.");
  lines.push("  - Use the KB excerpts for factual claims. Don't invent product details.");
  lines.push("");
  lines.push("HARD RULES — violating these is a failure:");
  lines.push("  - LINKS: When you link to a product, use the `PRODUCT URL (canonical)` provided above EXACTLY. Never extract URLs from the ad copy, the post caption, or the commenter's text. Never invent shortened domains (e.g. 'superfoodtabs.com'). Never use bit.ly / l.facebook.com / utm-laden tracking links. If no canonical URL is provided, don't include any URL — say 'on our website' and let them find it.");
  lines.push("  - COUPONS: Coupons NEVER apply automatically. The customer must enter the code on the checkout page. NEVER say things like 'the coupon will apply automatically', 'we'll apply the discount', 'you'll see the discount at checkout', or anything implying it's pre-applied. If you mention a coupon, say the customer needs to enter it at checkout (or just don't mention coupons at all).");
  lines.push("  - PROMISES: Don't promise anything that requires us to take action — refunds, replacements, account changes, shipping updates, phone support. If a commenter is asking for action, escalate.");
  lines.push("");
  if (ctx.humanHint) {
    lines.push(`AGENT HINT (a trusted operator re-triggered this moderation with the following context — weight this heavily): ${ctx.humanHint}`);
    lines.push("");
  }
  lines.push(`COMMENT: ${ctx.comment.body.slice(0, 1500)}`);
  lines.push(`COMMENTER: ${ctx.comment.sender_name || "(unknown)"}${ctx.comment.sender_username ? ` (@${ctx.comment.sender_username})` : ""}`);
  lines.push(`PAGE: ${ctx.page.name || "(unnamed)"} (${ctx.page.platform} ${ctx.page.type})`);
  if (ctx.post?.message) lines.push(`POST CAPTION: ${ctx.post.message.slice(0, 400)}`);
  if (ctx.matchedProduct) {
    const desc = (ctx.matchedProduct.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    lines.push(`POST PRODUCT: ${ctx.matchedProduct.title}${desc ? ` — ${desc}` : ""}`);
    if (ctx.matchedProduct.url) {
      lines.push(`PRODUCT URL (canonical): ${ctx.matchedProduct.url}`);
    }
  }
  if (ctx.brandProofPoints) {
    lines.push("");
    lines.push("BRAND PROOF POINTS (weave 1-2 in when handling price/skepticism objections — don't recite the whole list):");
    lines.push(ctx.brandProofPoints);
  }
  // Active crisis touching this product — surface the restock date so
  // stock-question replies cite a real date instead of "check the
  // product page". The orchestrator chooses how to use it.
  if (ctx.crisis) {
    const restock = ctx.crisis.expected_restock_date
      ? new Date(ctx.crisis.expected_restock_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "TBD";
    lines.push(`CRISIS / STOCK STATUS: "${ctx.crisis.affected_product_title}" is currently out of stock. Expected restock: ${restock}. If the comment asks about availability of that flavor/variant, name the date directly and offer the restock-notification opt-in.`);
  }
  lines.push("");
  lines.push(rag);
  lines.push("");
  lines.push(policies);
  lines.push("");
  lines.push(senderHistory);
  lines.push("");
  lines.push("Respond with ONLY valid JSON, no prose outside the JSON:");
  lines.push("{");
  lines.push('  "action": "reply" | "hidden_reply" | "like" | "ignore" | "escalate",');
  lines.push('  "visibility": "public" | "hidden" | null,');
  lines.push('  "reply_body": "string or null",');
  lines.push('  "reasoning": "one-sentence summary of the decision",');
  lines.push('  "considers": {');
  lines.push('    "helpfulness": "what does this reply do for the commenter?",');
  lines.push('    "public_impact": "how does this read to others who scroll past?",');
  lines.push('    "sales_consideration": "does this help or hurt likelihood of new buyers?"');
  lines.push('  }');
  lines.push("}");
  return lines.join("\n");
}

async function runPass2(
  apiKey: string,
  ctx: CommentContext,
  pass1Sentiment: ModerationSentiment,
  logUsage: (u: ClaudeUsage | undefined, tag: string) => void,
): Promise<ModerationDecision> {
  const admin = createAdminClient();
  const [{ ragText, sources }, policies, senderHistory] = await Promise.all([
    gatherPass2RagContext(admin, ctx),
    getBrandPolicies(admin, ctx.workspaceId),
    getSenderHistory(admin, ctx.workspaceId, ctx.comment.sender_id, ctx.socialCommentId),
  ]);

  const prompt = buildPass2Prompt(ctx, ragText, policies, senderHistory);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPUS_MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    return { ...FALLBACK_DECISION, model: OPUS_MODEL, sentiment: pass1Sentiment, reasoning: `Opus API ${res.status}: ${errBody.slice(0, 120)}` };
  }
  const data = await res.json();
  logUsage(data.usage, "pass2-opus");
  const text = (data.content?.[0]?.text || "") as string;
  return parsePass2Output(text, pass1Sentiment, sources);
}

function parsePass2Output(text: string, sentiment: ModerationSentiment, sources: string[]): ModerationDecision {
  const snippet = text.slice(0, 180).replace(/\s+/g, " ").trim();
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ...FALLBACK_DECISION, model: OPUS_MODEL, sentiment, reasoning: `Opus produced no JSON: "${snippet}"` };
    const parsed = JSON.parse(match[0]);
    const action = parsed.action as ModerationAction;
    const visibility = parsed.visibility as "public" | "hidden" | null;
    return {
      reasoning: String(parsed.reasoning || ""),
      action,
      reply_body: parsed.reply_body ?? null,
      sentiment,
      ban_user: false,                  // Pass 2 never bans — that's Pass 1's job
      ban_reason: null,
      visibility,
      considers: (parsed.considers as ModerationConsiders) ?? null,
      kb_sources: sources,
      model: OPUS_MODEL,
    };
  } catch (err) {
    return { ...FALLBACK_DECISION, model: OPUS_MODEL, sentiment, reasoning: `Opus parse fail: ${errText(err)}. "${snippet}"` };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Context loader
// ────────────────────────────────────────────────────────────────────────

async function buildContext(
  admin: Admin,
  workspaceId: string,
  socialCommentId: string,
  humanHint: string | null = null,
): Promise<CommentContext | null> {
  const { data: comment } = await admin
    .from("social_comments")
    .select("body, meta_sender_id, meta_sender_name, meta_sender_username, is_ad, page_type, matched_product_id, meta_post_id, meta_page_id")
    .eq("id", socialCommentId).single();
  if (!comment) return null;

  const [{ data: page }, { data: post }, productRow, { data: ws }] = await Promise.all([
    admin.from("meta_pages").select("meta_page_name, page_type, platform").eq("id", comment.meta_page_id).single(),
    admin.from("meta_post_cache").select("permalink_url, message, is_ad").eq("workspace_id", workspaceId).eq("meta_post_id", comment.meta_post_id).maybeSingle(),
    comment.matched_product_id
      ? admin.from("products").select("title, description, handle").eq("id", comment.matched_product_id).single()
      : Promise.resolve({ data: null }),
    admin.from("workspaces").select("storefront_domain, shopify_domain, shopify_myshopify_domain, ad_destination_domains, social_brand_proof_points, social_competitor_keywords").eq("id", workspaceId).single(),
  ]);

  // Construct the canonical PDP URL from the workspace's primary
  // customer-facing domain + the product handle. Priority:
  //   1. ad_destination_domains[0] — where ads currently send traffic
  //      (the brand site customers actually know — `superfoodscompany.com`).
  //   2. storefront_domain — the in-house storefront (`shop.…`); future-state,
  //      only used once ad traffic is cut over.
  //   3. shopify_domain / .myshopify.com — last-resort fallback.
  // AI ad copy often contains shortlinks (bit.ly), tracking-laden URLs,
  // or random domain variants; we always override with the catalog URL.
  function buildProductUrl(handle: string): string | null {
    const adDomains = (ws?.ad_destination_domains as string[] | null) || [];
    const rawHost =
      adDomains[0]
      || (ws?.storefront_domain as string | undefined)
      || (ws?.shopify_domain as string | undefined)
      || (ws?.shopify_myshopify_domain as string | undefined);
    if (!rawHost) return null;
    const host = rawHost.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return `https://${host}/products/${handle}`;
  }

  // Active crisis touching the matched product? Drives "back in
  // stock by July 9" replies when a commenter asks about stock.
  // We match by product_id on the crisis row OR by parent product
  // (any active crisis whose affected_variant_id belongs to this
  // product). When the matched product covers multiple variants
  // and only one is in crisis (Mixed Berry tab while other tab
  // flavors are fine), surfacing the variant + restock date is
  // still useful — the AI can disambiguate.
  let crisis: CommentContext["crisis"] = null;
  if (comment.matched_product_id) {
    // crisis_events.affected_variant_id is a Shopify variant ID (text),
    // not our internal UUID. Join via product_variants.shopify_variant_id.
    const { data: variantsOfProduct } = await admin
      .from("product_variants")
      .select("shopify_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("product_id", comment.matched_product_id);
    const shopifyVariantIds = (variantsOfProduct || [])
      .map(v => v.shopify_variant_id as string | null)
      .filter((v): v is string => !!v);
    if (shopifyVariantIds.length) {
      const { data: crisisRow } = await admin
        .from("crisis_events")
        .select("name, affected_product_title, expected_restock_date, status, affected_variant_id")
        .eq("workspace_id", workspaceId)
        .eq("status", "active")
        .in("affected_variant_id", shopifyVariantIds)
        .order("expected_restock_date", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (crisisRow) {
        crisis = {
          name: crisisRow.name as string,
          affected_product_title: crisisRow.affected_product_title as string,
          expected_restock_date: (crisisRow.expected_restock_date as string | null) || null,
        };
      }
    }
  }

  return {
    workspaceId,
    socialCommentId,
    comment: {
      body: comment.body || "",
      sender_name: comment.meta_sender_name,
      sender_username: comment.meta_sender_username,
      sender_id: comment.meta_sender_id,
      is_ad: !!comment.is_ad,
      page_type: comment.page_type,
      matched_product_id: comment.matched_product_id,
    },
    page: {
      name: page?.meta_page_name ?? null,
      type: page?.page_type ?? comment.page_type,
      platform: page?.platform ?? "facebook",
    },
    post: post ? { permalink_url: post.permalink_url, message: post.message, is_ad: !!post.is_ad } : null,
    matchedProduct: productRow.data
      ? {
          title: (productRow.data as { title: string }).title,
          description: (productRow.data as { description: string | null }).description,
          url: buildProductUrl((productRow.data as { handle: string }).handle),
        }
      : null,
    brandProofPoints: ((ws as { social_brand_proof_points: string | null } | null)?.social_brand_proof_points || null),
    competitorKeywords: ((ws as { social_competitor_keywords: string | null } | null)?.social_competitor_keywords || null),
    humanHint,
    crisis,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Public entry
// ────────────────────────────────────────────────────────────────────────

export async function moderateSocialComment(
  workspaceId: string,
  socialCommentId: string,
  humanHint: string | null = null,
): Promise<ModerationDecision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ...FALLBACK_DECISION, reasoning: "ANTHROPIC_API_KEY not set" };

  const admin = createAdminClient();
  const ctx = await buildContext(admin, workspaceId, socialCommentId, humanHint);
  if (!ctx) return { ...FALLBACK_DECISION, reasoning: "social_comments row not found" };

  const logUsage = (usage: ClaudeUsage | undefined, tag: string) => {
    void logAiUsage({ workspaceId, model: tag.startsWith("pass1") ? HAIKU_MODEL : OPUS_MODEL, usage, purpose: `social-moderation:${tag}` });
  };

  // Empty-body comments shouldn't run either pass — escalate so a human
  // sees them. (Saves an Anthropic call too.)
  if (!ctx.comment.body.trim()) {
    return { ...FALLBACK_DECISION, model: "n/a", reasoning: "Empty comment body" };
  }

  // ── Pre-check: previously banned user? ────────────────────────────
  // Bans on Meta are per-Page. Our banned_meta_users row is workspace-wide
  // so when a repeat offender shows up on a different page we recognize
  // them and skip the AI entirely.
  const banShortCircuit = await checkPreviouslyBanned(admin, workspaceId, ctx.comment.sender_id);
  if (banShortCircuit) return banShortCircuit;

  // ── Pass 1 ────────────────────────────────────────────────────────
  const p1 = await runPass1(apiKey, ctx, logUsage);
  if (!p1) return { ...FALLBACK_DECISION, model: HAIKU_MODEL, reasoning: "Pass 1 (Haiku) failed — escalating" };

  if (p1.classification !== "clean") {
    return pass1ToDecision(p1);
  }

  // ── Pass 2 ────────────────────────────────────────────────────────
  return runPass2(apiKey, ctx, p1.sentiment, logUsage);
}
