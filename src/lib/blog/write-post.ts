/**
 * Auto-blog writer (spec: auto-blog-generation).
 *
 * Opus 4.8 with the Anthropic **web search** server tool — the model researches
 * the topic live (trend framing, recipe specifics, supporting facts), grounds
 * the article in our proprietary intelligence (ingredients, real citations,
 * customer phrases), and writes in a named persona's voice under strict
 * anti-"reads like AI" rules. Returns the post fields + image prompts; the cron
 * generates the imagery and inserts.
 *
 * Raw fetch to the Messages API (house style — see import-article.ts). Web
 * search is incompatible with structured-output format, so the model emits a
 * delimited block we parse (long HTML survives without JSON-escaping).
 */
import type { TopicPlan } from "@/lib/blog/select-topic";

const MODEL = "claude-opus-4-8";

export interface WrittenPost {
  title: string;
  handle: string;
  excerpt: string;
  seoTitle: string;
  seoDescription: string;
  tags: string[];
  /** HTML body; may contain {{IMAGE: scene}} placeholders for in-body shots. */
  html: string;
  /** Scene that composites the isolated product pouch (landscape blog hero). */
  heroImagePrompt: string;
  /** 4:5 portrait scene compositing the pouch (IG/FB social variant). */
  socialImagePrompt: string;
}

function systemPrompt(plan: TopicPlan): string {
  const a = plan.author;
  const intel = plan.intelligence;
  const research = intel.research
    .slice(0, 16)
    .map((r) => `- ${r.headline}: ${r.mechanism}${r.citations.length ? ` [studies: ${r.citations.join("; ")}]` : ""}`)
    .join("\n");
  return [
    `You are ${a.name}, ${a.role} at the brand. Bio: ${a.bio}`,
    `You write the brand's blog. Write ONE article about "${plan.product.title}" in the "${plan.archetype}" style, targeting the search topic "${plan.targetKeyword}".`,
    ``,
    `GOALS (every article serves these): rank for the target topic, give real value to people who already bought the product, and reassure people considering it.`,
    ``,
    `USE THE WEB SEARCH TOOL to research current framing, real facts, and — for recipes — real proportions/steps. Search 2-4 times. Ground claims in what you find + the proprietary facts below.`,
    ``,
    `PROPRIETARY FACTS (only WE have these — use them, they're what make this not generic):`,
    `Ingredients: ${intel.ingredients.join(", ")}`,
    intel.topBenefits.length ? `Top benefits from our reviews: ${intel.topBenefits.join(", ")}` : ``,
    intel.customerPhrases.length ? `Real customer phrases (quote a couple naturally): ${intel.customerPhrases.slice(0, 10).map((p) => `"${p}"`).join(", ")}` : ``,
    research ? `Ingredient research (cite study names in prose, never invent URLs):\n${research}` : ``,
    ``,
    `WRITE LIKE A HUMAN — search engines demote scaled AI content. Hard rules:`,
    `- Open with a specific, first-person moment, not a definition. NO "In today's world", "In conclusion", "Look no further", "delve", "unlock", "game-changer", "navigating the world of".`,
    `- Vary sentence length (some short. some longer, with a clause). Have an opinion. Allow small asides.`,
    `- Be concrete: real numbers, measurements, sensory detail. Honest caveats over hype.`,
    `- Link to the product once or twice with <a href="/${plan.product.handle}">${plan.product.title}</a>. For recipes, give exact ingredient lists + numbered steps.`,
    `- End the body with an FDA-style disclaimer paragraph (studies describe ingredients, not the finished product).`,
    `- DO NOT include the author byline, the title as an <h1>, or a featured image in the HTML — those are added around it. Start the body with a <p>. Use <h2>/<h3>, <p>, <ul>/<ol>, <blockquote>, and {{IMAGE: ...}} placeholders.`,
    `- Insert 1-2 {{IMAGE: short photographic scene}} placeholders where an image belongs (these become generated photos — describe scenes, not the product pouch).`,
    plan.existingTitles.length ? `- DO NOT duplicate these existing titles: ${plan.existingTitles.map((t) => `"${t}"`).join(", ")}.` : ``,
    ``,
    `OUTPUT — after researching, emit EXACTLY this block and nothing after it:`,
    `<<<POST>>>`,
    `TITLE: <compelling, human, not clickbait>`,
    `HANDLE: <kebab-case-slug, no product name stuffing>`,
    `EXCERPT: <1-2 sentence summary, ~200 chars>`,
    `SEO_TITLE: <~60 chars, includes the target topic>`,
    `SEO_DESCRIPTION: <~155 chars>`,
    `TAGS: <comma-separated, 4-6>`,
    `HERO_IMAGE: <a styled photo scene that includes the product pouch — e.g. on a sunlit kitchen counter with relevant props; landscape>`,
    `SOCIAL_IMAGE: <a vertical 4:5 portrait version of a hero-like scene with the pouch, eye-catching for Instagram>`,
    `HTML:`,
    `<the full article HTML>`,
    `<<<END>>>`,
  ].filter(Boolean).join("\n");
}

interface AnthropicContentBlock { type: string; text?: string }
interface AnthropicResponse { stop_reason?: string; content?: AnthropicContentBlock[] }

/** Call Opus 4.8 with web search, resuming through pause_turn, return final text. */
async function runWithWebSearch(system: string, userBrief: string): Promise<string> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // read at call time (env may load after import)
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
  const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: userBrief }];
  let finalText = "";
  for (let i = 0; i < 6; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12000,
        system,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
        messages,
      }),
    });
    if (!res.ok) throw new Error(`anthropic_${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as AnthropicResponse;
    finalText = (json.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n").trim();
    if (json.stop_reason === "pause_turn") {
      // Server-side tool loop hit its cap — resend with the assistant turn to continue.
      messages.push({ role: "assistant", content: json.content });
      continue;
    }
    break;
  }
  return finalText;
}

function field(text: string, name: string): string {
  const m = text.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return m ? m[1].trim() : "";
}

/** Research + write one post. Throws if the model output can't be parsed. */
export async function writeBlogPost(plan: TopicPlan): Promise<WrittenPost> {
  const system = systemPrompt(plan);
  const brief = `Research and write the article now. Product: ${plan.product.title}. Style: ${plan.archetype}. Target topic: "${plan.targetKeyword}".`;
  const text = await runWithWebSearch(system, brief);

  const block = text.slice(text.indexOf("<<<POST>>>"));
  if (!block.includes("<<<POST>>>")) throw new Error("writer: no POST block in output");
  const htmlMatch = block.match(/HTML:\s*([\s\S]*?)<<<END>>>/i);
  const html = (htmlMatch ? htmlMatch[1] : "").trim();
  if (!html) throw new Error("writer: no HTML in output");

  const tags = field(block, "TAGS").split(",").map((t) => t.trim()).filter(Boolean);
  const handleRaw = field(block, "HANDLE") || field(block, "TITLE");
  const handle = handleRaw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80);

  return {
    title: field(block, "TITLE"),
    handle,
    excerpt: field(block, "EXCERPT"),
    seoTitle: field(block, "SEO_TITLE"),
    seoDescription: field(block, "SEO_DESCRIPTION"),
    tags,
    html,
    heroImagePrompt: field(block, "HERO_IMAGE"),
    socialImagePrompt: field(block, "SOCIAL_IMAGE"),
  };
}
