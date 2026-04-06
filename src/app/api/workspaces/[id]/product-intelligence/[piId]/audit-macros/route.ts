import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const SONNET = "claude-sonnet-4-20250514";

async function aiCall(system: string, user: string, maxTokens = 500): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: SONNET, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) return `(AI error: ${res.status})`;
  const data = await res.json();
  return (data.content?.[0] as { text: string })?.text?.trim() || "";
}

// POST: Audit all macros for a product against its intelligence
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; piId: string }> }
) {
  const { id: workspaceId, piId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Load product intelligence
  const { data: pi } = await admin.from("product_intelligence")
    .select("id, product_id, title, content, labeled_urls")
    .eq("id", piId).eq("workspace_id", workspaceId).single();
  if (!pi) return NextResponse.json({ error: "Product intelligence not found" }, { status: 404 });

  // Find all macros for this product (by product_id OR by name containing product title)
  const { data: macros } = await admin.from("macros")
    .select("id, name, body_text, category, active")
    .eq("workspace_id", workspaceId)
    .or(`product_id.eq.${pi.product_id},name.ilike.%${pi.title}%`)
    .order("name");

  if (!macros?.length) {
    return NextResponse.json({ audits: [], total: 0, message: "No macros found for this product" });
  }

  // Truncate intelligence for prompt (keep first 8000 chars — key sections)
  const intelligenceContext = pi.content.slice(0, 8000);

  // Build labeled URLs reference for Sonnet
  const labeledUrls = (pi.labeled_urls as { url: string; label: string }[]) || [];
  const urlReference = labeledUrls.length > 0
    ? "\n\nPRODUCT URLS (use these in macros when relevant):\n" + labeledUrls.map(u => `- ${u.label}: ${u.url}`).join("\n")
    : "";

  const audits = [];

  for (const macro of macros) {
    const text = macro.body_text || "";

    // Detect issues
    const hasEmoji = /[\u{1F300}-\u{1FFFF}]/u.test(text);
    const hasYoutube = /youtube\.com|youtu\.be/i.test(text);
    const hasGreeting = /^(hi|hey|hello|thanks|thank you)/im.test(text);
    const links = text.match(/https?:\/\/[^\s)]+/g) || [];
    const hasFluff = /hope you.*day|hope this finds|part of the.*community|anything else we can|have a (great|wonderful)/i.test(text);

    const issues: string[] = [];
    if (hasEmoji) issues.push("contains emoji");
    if (hasYoutube) issues.push("contains YouTube link");
    if (hasGreeting) issues.push("starts with greeting");
    if (hasFluff) issues.push("contains fluff/filler");
    if (links.some((l: string) => l.endsWith("!") || l.endsWith(",") || l.endsWith("."))) issues.push("broken link(s)");

    // Ask Sonnet to rewrite
    const raw = await aiCall(
      `You are auditing a customer support macro against product intelligence data. Your job is to rewrite the macro to be accurate, concise, professional, and aligned with the product intelligence.

RULES:
- No emoji. No greetings (no "Hi!", "Hello!", "Hey there!"). No fluff closings ("Have a great day!", "Thanks for being part of our community!").
- Remove ALL YouTube links.
- Fix or remove broken links (ending in ! , . or with trailing punctuation).
- Replace old/broken links with the correct labeled product URLs provided below. Include relevant links in macros — customers appreciate direct links to reviews, ingredients, how it works, etc.
- Cross-reference claims against the product intelligence — fix any inaccurate claims.
- Keep it concise — max 2-3 sentences per paragraph. No walls of text. Short, scannable paragraphs.
- If the macro references a specific product feature, use the EXACT claim from the product intelligence (ingredients, dosages, clinical studies).
- Output HTML format: use <p> tags for paragraphs, <a href="url"> for hyperlinked text (not raw URLs — always hyperlink with descriptive text like "check out our reviews" or "see the full ingredient list").
- The AI agent will add greetings and sign-offs — the macro should be just the factual content.

Return JSON: { "rewritten_html": "the rewritten macro in HTML", "rewritten_text": "plain text version", "changes": ["list of changes made"], "accuracy_issues": ["any claims that don't match the intelligence"] }`,

      `PRODUCT INTELLIGENCE:\n${intelligenceContext}${urlReference}\n\nCURRENT MACRO:\nName: ${macro.name}\nContent: ${text}`,
      600,
    );

    let rewrittenText = text;
    let rewrittenHtml = "";
    let changes: string[] = [];
    let accuracyIssues: string[] = [];

    try {
      const parsed = JSON.parse(raw.replace(/^```json?\n?/, "").replace(/\n?```$/, ""));
      rewrittenText = parsed.rewritten_text || parsed.rewritten || text;
      rewrittenHtml = parsed.rewritten_html || "";
      changes = parsed.changes || [];
      accuracyIssues = parsed.accuracy_issues || [];
    } catch {
      changes = ["Failed to parse AI response"];
    }

    audits.push({
      macro_id: macro.id,
      macro_name: macro.name,
      category: macro.category,
      active: macro.active,
      original: text,
      rewritten: rewrittenText,
      rewritten_html: rewrittenHtml,
      changes,
      accuracy_issues: accuracyIssues,
      issues_detected: issues,
      has_changes: rewrittenText !== text,
    });
  }

  return NextResponse.json({
    product: pi.title,
    total: audits.length,
    with_changes: audits.filter(a => a.has_changes).length,
    with_accuracy_issues: audits.filter(a => a.accuracy_issues.length > 0).length,
    audits,
  });
}

// PATCH: Apply approved rewrites
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; piId: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();
  const { updates } = body as { updates: { macro_id: string; body_text: string; body_html?: string }[] };

  if (!updates?.length) return NextResponse.json({ error: "No updates" }, { status: 400 });

  let applied = 0;
  for (const u of updates) {
    const updateData: Record<string, unknown> = { body_text: u.body_text, updated_at: new Date().toISOString() };
    if (u.body_html) updateData.body_html = u.body_html;
    const { error } = await admin.from("macros").update(updateData).eq("id", u.macro_id).eq("workspace_id", workspaceId);
    if (!error) applied++;
  }

  return NextResponse.json({ ok: true, applied });
}
