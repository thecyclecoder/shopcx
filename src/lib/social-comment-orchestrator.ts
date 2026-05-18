/**
 * Sonnet orchestrator — Meta comments moderation flavor.
 *
 * Fork of `sonnet-orchestrator-v2.ts` with a different concern: this
 * one decides what to do with a public comment on a Page post, not how
 * to resolve a 1:1 support ticket. The contract is intentionally
 * narrower:
 *
 *   ─── Decision schema ───
 *   {
 *     "reasoning": "...",
 *     "action": "reply" | "like" | "hide" | "delete" | "ignore" | "escalate",
 *     "reply_body": "..."|null,
 *     "sentiment": "positive" | "negative" | "neutral" | "spam" | "abusive",
 *     "ban_user": boolean,
 *     "ban_reason": "..."|null
 *   }
 *
 *   ─── Tools (called on demand) ───
 *     get_product_knowledge   — product catalog + macros + KB matches
 *     get_brand_policies      — community guidelines / banned topics
 *                               from sonnet_prompts (scope='social_moderation')
 *     get_sender_history      — past comments + statuses from this sender
 *
 * No customer data tools — commenters are anonymous Meta IDs. If a
 * commenter happens to be a known customer that's interesting context,
 * but Sonnet doesn't need it to decide reply vs hide.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { retrieveContext } from "@/lib/rag";
import { logAiUsage, type ClaudeUsage } from "@/lib/ai-usage";

const MODEL_ID = "claude-sonnet-4-20250514";
type Admin = ReturnType<typeof createAdminClient>;

export type ModerationAction =
  | "reply"
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

export interface ModerationDecision {
  reasoning: string;
  action: ModerationAction;
  reply_body: string | null;
  sentiment: ModerationSentiment;
  ban_user: boolean;
  ban_reason: string | null;
}

const FALLBACK_DECISION: ModerationDecision = {
  reasoning: "Orchestrator error — escalating to a human moderator",
  action: "escalate",
  reply_body: null,
  sentiment: "neutral",
  ban_user: false,
  ban_reason: null,
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
  page: {
    name: string | null;
    type: string;
    platform: string;
  };
  post: {
    permalink_url: string | null;
    message: string | null;
    is_ad: boolean;
  } | null;
  matchedProduct: { title: string; description: string | null } | null;
}

function buildToolDefinitions() {
  return [
    {
      name: "get_product_knowledge",
      description:
        "Get product catalog descriptions, pre-written response macros, and knowledge base articles. Use when the comment mentions a product, asks a question we may have a macro for, or needs a factual answer.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search term to focus retrieval (e.g. 'caffeine coffee' or 'shipping')",
          },
        },
        required: [] as string[],
      },
    },
    {
      name: "get_brand_policies",
      description:
        "Get this workspace's moderation policies (banned topics, escalation triggers, tone guidance). Use when you're unsure whether a comment crosses a line.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "get_sender_history",
      description:
        "Get this commenter's past comments + outcomes in this workspace. Use when the sender appears repetitive, hostile, or might be a repeat positive supporter.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
  ];
}

async function buildContext(
  admin: Admin,
  workspaceId: string,
  socialCommentId: string,
): Promise<CommentContext | null> {
  const { data: comment } = await admin
    .from("social_comments")
    .select(
      "body, meta_sender_id, meta_sender_name, meta_sender_username, is_ad, page_type, matched_product_id, meta_post_id, meta_page_id",
    )
    .eq("id", socialCommentId)
    .single();

  if (!comment) return null;

  const [{ data: page }, { data: post }, productRow] = await Promise.all([
    admin
      .from("meta_pages")
      .select("meta_page_name, page_type, platform")
      .eq("id", comment.meta_page_id)
      .single(),
    admin
      .from("meta_post_cache")
      .select("permalink_url, message, is_ad")
      .eq("workspace_id", workspaceId)
      .eq("meta_post_id", comment.meta_post_id)
      .maybeSingle(),
    comment.matched_product_id
      ? admin.from("products").select("title, description").eq("id", comment.matched_product_id).single()
      : Promise.resolve({ data: null }),
  ]);

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
    post: post
      ? { permalink_url: post.permalink_url, message: post.message, is_ad: !!post.is_ad }
      : null,
    matchedProduct: productRow.data
      ? {
          title: (productRow.data as { title: string }).title,
          description: (productRow.data as { description: string | null }).description,
        }
      : null,
  };
}

function buildPrompt(ctx: CommentContext, brandPoliciesSnippet: string): string {
  const lines: string[] = [];
  lines.push(
    `You are the brand-safety moderator for the ${ctx.page.platform} page "${ctx.page.name || "(unnamed)"}" (page type: ${ctx.page.type}).`,
  );
  lines.push(
    `Your job is to decide what to do with one public comment. Public means anyone scrolling the page can see it. Choose carefully — over-hiding looks censorial, under-moderation lets spam and abuse stay up.`,
  );
  lines.push("");

  lines.push(`COMMENT BODY: ${ctx.comment.body.slice(0, 1500)}`);
  lines.push(
    `COMMENTER: ${ctx.comment.sender_name || "(name unknown)"}${ctx.comment.sender_username ? ` (@${ctx.comment.sender_username})` : ""}`,
  );
  lines.push(`ON ${ctx.comment.is_ad ? "an AD" : "an ORGANIC POST"}`);

  if (ctx.post) {
    if (ctx.post.message) lines.push(`POST CAPTION: ${ctx.post.message.slice(0, 300)}`);
    if (ctx.post.permalink_url) lines.push(`POST URL: ${ctx.post.permalink_url}`);
  }

  if (ctx.matchedProduct) {
    const desc = (ctx.matchedProduct.description || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    lines.push(`MATCHED PRODUCT: ${ctx.matchedProduct.title}${desc ? ` — ${desc}` : ""}`);
  }

  if (brandPoliciesSnippet) {
    lines.push("");
    lines.push(brandPoliciesSnippet);
  }

  lines.push("");
  lines.push("DECISION TYPES (pick exactly one for `action`):");
  lines.push("- reply    — answer the customer publicly. Set reply_body. Keep it short, mirror their tone, no markdown.");
  lines.push("- like     — acknowledge a positive comment without writing a reply.");
  lines.push("- hide     — hide the comment from public view (visible to commenter only). Use for spam, mild abuse, brand-damaging false claims.");
  lines.push("- delete   — remove the comment entirely. Use for harassment, slurs, doxxing, scams, or anything that would never be allowed.");
  lines.push("- ignore   — no action. Comment stays public but off the moderation queue. Use for innocuous content that doesn't warrant a like or reply.");
  lines.push("- escalate — a human should look at this. Use when the comment is ambiguous, makes a serious complaint, or could become a PR issue.");
  lines.push("");
  lines.push("BAN_USER: set true ONLY for repeat abusers or obvious spam accounts. Most decisions should leave ban_user=false.");
  lines.push("");
  lines.push("When you have enough data, respond with ONLY valid JSON (no prose, no tool calls):");
  lines.push("{");
  lines.push('  "reasoning": "brief explanation",');
  lines.push('  "action": "reply" | "like" | "hide" | "delete" | "ignore" | "escalate",');
  lines.push('  "reply_body": "string or null",');
  lines.push('  "sentiment": "positive" | "negative" | "neutral" | "spam" | "abusive",');
  lines.push('  "ban_user": false,');
  lines.push('  "ban_reason": null');
  lines.push("}");

  return lines.join("\n");
}

async function executeToolCall(
  admin: Admin,
  name: string,
  input: Record<string, unknown>,
  ctx: CommentContext,
): Promise<string> {
  switch (name) {
    case "get_product_knowledge":
      return getProductKnowledge(admin, ctx.workspaceId, (input.query as string) || ctx.comment.body);
    case "get_brand_policies":
      return getBrandPolicies(admin, ctx.workspaceId);
    case "get_sender_history":
      return getSenderHistory(admin, ctx.workspaceId, ctx.comment.sender_id, ctx.socialCommentId);
    default:
      return `Unknown tool: ${name}`;
  }
}

async function getProductKnowledge(admin: Admin, workspaceId: string, query: string): Promise<string> {
  const rag = await retrieveContext(workspaceId, query.slice(0, 500), 6);
  const parts: string[] = [];
  if (rag.macros?.length) {
    parts.push("MATCHING MACROS:");
    for (const m of rag.macros) {
      const body = (m.body_text || m.body_html || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 250);
      parts.push(`- ${m.name}: ${body}`);
    }
  }
  if (rag.chunks?.length) {
    parts.push("\nKNOWLEDGE BASE:");
    for (const c of rag.chunks) {
      const body = (c.chunk_text || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 250);
      parts.push(`- ${c.kb_title || "Article"}: ${body}`);
    }
  }
  if (!parts.length) return "No matching macros or KB articles for this query.";
  return parts.join("\n");
}

async function getBrandPolicies(admin: Admin, workspaceId: string): Promise<string> {
  // Reuse the existing sonnet_prompts table for moderation guidance —
  // admins tune the AI behavior the same way they tune the ticket
  // orchestrator. We scope to the social moderation context via title
  // prefix until a dedicated scope column lands.
  const { data: prompts } = await admin
    .from("sonnet_prompts")
    .select("title, content, category")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .eq("status", "approved")
    .ilike("title", "social%")
    .order("category")
    .order("sort_order");

  if (!prompts?.length) {
    return "No workspace-specific moderation policies configured. Apply standard brand-safety judgment.";
  }
  return prompts.map(p => `[${p.category}] ${p.content}`).join("\n");
}

async function getSenderHistory(
  admin: Admin,
  workspaceId: string,
  senderId: string,
  exceptCommentId: string,
): Promise<string> {
  const { data: history } = await admin
    .from("social_comments")
    .select("body, status, sentiment, created_at")
    .eq("workspace_id", workspaceId)
    .eq("meta_sender_id", senderId)
    .neq("id", exceptCommentId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!history?.length) return "No prior comments from this sender in this workspace.";

  const parts = ["PRIOR COMMENTS FROM THIS SENDER:"];
  for (const h of history) {
    const date = new Date(h.created_at as string).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    parts.push(`- ${date} | ${h.status}${h.sentiment ? ` (${h.sentiment})` : ""}: ${(h.body as string || "").slice(0, 120)}`);
  }
  return parts.join("\n");
}

/**
 * Main entry — invoked by the Inngest social-comment-moderate handler.
 * Returns a ModerationDecision regardless of failure mode (falls back
 * to escalate on any error so a human still sees the comment).
 */
export async function moderateSocialComment(
  workspaceId: string,
  socialCommentId: string,
): Promise<ModerationDecision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ...FALLBACK_DECISION, reasoning: "ANTHROPIC_API_KEY not set" };
  }

  const admin = createAdminClient();
  const ctx = await buildContext(admin, workspaceId, socialCommentId);
  if (!ctx) return { ...FALLBACK_DECISION, reasoning: "social_comments row not found" };

  // Brand policies are short — pre-load instead of forcing Sonnet to
  // call a tool. Tools stay for the heavier lookups (RAG, history).
  const brandPolicies = await getBrandPolicies(admin, workspaceId);
  const prompt = buildPrompt(ctx, brandPolicies);
  const tools = buildToolDefinitions();

  const logUsage = (usage: ClaudeUsage | undefined, tag: string) => {
    void logAiUsage({
      workspaceId,
      model: MODEL_ID,
      usage,
      purpose: `social-moderation:${tag}`,
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [{ role: "user", content: prompt }];

  try {
    for (let round = 0; round < 3; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL_ID,
          max_tokens: 1500,
          tools,
          messages,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        return {
          ...FALLBACK_DECISION,
          reasoning: `Sonnet API error ${res.status}: ${errBody.slice(0, 150)}`,
        };
      }

      const data = await res.json();
      logUsage(data.usage, `round${round}`);
      const content = data.content || [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolUses = content.filter((b: any) => b.type === "tool_use");
      const textBlocks = content.filter((b: { type: string }) => b.type === "text");

      if (toolUses.length === 0) {
        const text = textBlocks.map((b: { text: string }) => b.text).join("");
        return parseDecision(text);
      }

      const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
      for (const tc of toolUses) {
        const result = await executeToolCall(admin, tc.name, tc.input || {}, ctx);
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
      }
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: toolResults });
    }

    return { ...FALLBACK_DECISION, reasoning: "Max tool rounds exceeded" };
  } catch (err) {
    return {
      ...FALLBACK_DECISION,
      reasoning: `Sonnet error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function parseDecision(text: string): ModerationDecision {
  const snippet = (text || "").slice(0, 180).replace(/\s+/g, " ").trim();
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ...FALLBACK_DECISION, reasoning: `No JSON in response: "${snippet}"` };
    const parsed = JSON.parse(match[0]);

    if (!parsed.action || !parsed.reasoning) {
      return { ...FALLBACK_DECISION, reasoning: `Missing required fields: ${Object.keys(parsed).join(", ")}` };
    }
    return {
      reasoning: String(parsed.reasoning),
      action: parsed.action as ModerationAction,
      reply_body: parsed.reply_body ?? null,
      sentiment: (parsed.sentiment as ModerationSentiment) ?? "neutral",
      ban_user: !!parsed.ban_user,
      ban_reason: parsed.ban_reason ?? null,
    };
  } catch (err) {
    return {
      ...FALLBACK_DECISION,
      reasoning: `Parse fail: ${err instanceof Error ? err.message : String(err)}. Got: "${snippet}"`,
    };
  }
}
