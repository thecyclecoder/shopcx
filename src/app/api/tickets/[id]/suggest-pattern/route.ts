import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { SONNET_MODEL } from "@/lib/ai-models";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// POST: Use Claude to analyze a ticket and suggest pattern phrases
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  let hintCategory: string | null = null;
  try {
    const body = await request.json();
    hintCategory = body.category || null;
  } catch {
    // No body sent — that's fine
  }

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI not configured (missing ANTHROPIC_API_KEY)" }, { status: 503 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Get ticket + first customer message
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, tags, workspace_id")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  const { data: messages } = await admin
    .from("ticket_messages")
    .select("body, direction, author_type")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(3);

  const customerMessage = messages?.find(m => m.direction === "inbound" && m.author_type === "customer");
  if (!customerMessage) {
    return NextResponse.json({ error: "No customer message found" }, { status: 400 });
  }

  // Get existing pattern categories for context
  const { data: existingPatterns } = await admin
    .from("smart_patterns")
    .select("category, name, phrases, auto_tag")
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .eq("active", true);

  const categorySummary = (existingPatterns || []).map(p =>
    `- ${p.category}: "${p.name}" | auto_tag: "${p.auto_tag || "none"}" | (${(p.phrases as string[]).length} phrases, e.g. "${(p.phrases as string[])[0]}")`
  ).join("\n");

  // If agent hinted a category, find the existing auto_tag for it
  let hintAutoTag: string | null = null;
  let hintCategoryName: string | null = null;
  if (hintCategory && existingPatterns) {
    const match = existingPatterns.find(p => p.category === hintCategory);
    if (match) {
      hintAutoTag = match.auto_tag;
      hintCategoryName = match.name;
    }
  }

  // Strip HTML from body
  const plainBody = (customerMessage.body || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  // Call Claude
  let hintLine = "";
  let tagInstruction = "3. What auto_tag should be applied? If using an existing category, you MUST use that category's existing auto_tag from the list above. Only suggest a new tag if you're creating a new category.";

  if (hintCategory) {
    hintLine = `\nAGENT HINT: The agent says this belongs to category "${hintCategory}"${hintCategoryName ? ` ("${hintCategoryName}")` : ""}. Use this category.${hintAutoTag ? ` Use auto_tag: "${hintAutoTag}".` : ""}\n`;
    if (hintAutoTag) {
      tagInstruction = `3. Use auto_tag: "${hintAutoTag}" (the existing tag for this category). Do NOT suggest a different tag.`;
    }
  }

  const prompt = `You are analyzing a customer support ticket to help build a pattern matching system.

EXISTING PATTERN CATEGORIES (with their auto_tags):
${categorySummary}
${hintLine}
TICKET:
Subject: ${ticket.subject || "(no subject)"}
Customer message: ${plainBody}

TASK:
1. Which existing category does this ticket best fit? If none fit, suggest a new category name (snake_case).
2. What 3-5 short phrases from this message would catch similar tickets in the future? Phrases should be lowercase, 2-5 words, generic enough to match variations but specific enough to not false-positive.
${tagInstruction}

Respond in JSON only:
{
  "category": "existing_or_new_category",
  "category_name": "Human Friendly Name",
  "phrases": ["phrase one", "phrase two", "phrase three"],
  "auto_tag": "the-tag",
  "reasoning": "One sentence explaining why"
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Claude API error:", err);
      return NextResponse.json({ error: "AI analysis failed" }, { status: 502 });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Could not parse AI response", raw: text }, { status: 500 });
    }

    const suggestion = JSON.parse(jsonMatch[0]);

    // Enforce existing auto_tag when agent hinted a known category
    const finalTag = hintAutoTag || suggestion.auto_tag;
    const finalCategory = hintCategory || suggestion.category;
    const finalCategoryName = (hintCategory && hintCategoryName) || suggestion.category_name;

    return NextResponse.json({
      suggestion: {
        category: finalCategory,
        category_name: finalCategoryName,
        phrases: suggestion.phrases,
        auto_tag: finalTag,
        reasoning: suggestion.reasoning,
      },
      ticket_id: ticketId,
      subject: ticket.subject,
    });
  } catch (err) {
    console.error("Pattern suggestion error:", err);
    return NextResponse.json({ error: "AI analysis failed" }, { status: 500 });
  }
}
