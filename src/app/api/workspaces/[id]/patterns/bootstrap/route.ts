import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generatePatternEmbedding } from "@/lib/embeddings";
import { readFile } from "fs/promises";
import { join } from "path";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// POST: One-time bootstrap — analyze Gorgias tickets with Claude Sonnet to expand pattern library
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }

  // Load existing patterns to give Claude context
  const { data: existingPatterns } = await admin
    .from("smart_patterns")
    .select("category, name, phrases, auto_tag")
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .eq("active", true);

  const existingSummary = (existingPatterns || []).map(p =>
    `${p.category}: ${p.name} | tag: ${p.auto_tag} | phrases: ${(p.phrases as string[]).slice(0, 5).join(", ")}`
  ).join("\n");

  // Load Gorgias ticket data
  let ticketSamples: string;
  try {
    const raw = await readFile(join(process.cwd(), "gorgias_tickets.json"), "utf-8");
    const tickets = JSON.parse(raw) as { subject: string; excerpt: string; tags: string[] }[];

    // Filter to real support tickets and sample them
    const real = tickets.filter(t =>
      !t.tags.includes("auto-close") && !t.tags.includes("non-support-related")
    );

    // Take a representative sample (max 200 tickets to fit in context)
    const sample = real.slice(0, 200);
    ticketSamples = sample.map(t =>
      `Subject: ${t.subject || "(none)"}\nExcerpt: ${(t.excerpt || "").slice(0, 200)}\nTags: ${t.tags.join(", ")}`
    ).join("\n---\n");
  } catch {
    return NextResponse.json({ error: "gorgias_tickets.json not found" }, { status: 404 });
  }

  // Call Claude Sonnet to analyze
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: `You are analyzing customer service tickets from a health supplement / superfood subscription company to improve their auto-tagging pattern library.

EXISTING PATTERNS (already in the system):
${existingSummary}

SAMPLE TICKETS (200 real support tickets with subjects, excerpts, and Gorgias tags):
${ticketSamples}

TASK:
1. For each EXISTING pattern category, suggest 10-20 additional keyword phrases that would catch more tickets. Focus on phrases NOT already in the existing lists. Include common misspellings and informal language.

2. Identify 3-5 NEW categories that aren't covered by the existing patterns. For each:
   - category: snake_case identifier
   - name: Human readable name
   - description: 2-3 sentences for embedding generation
   - auto_tag: lowercase hyphenated tag
   - phrases: 15-20 keyword phrases

Return JSON:
{
  "expanded_phrases": {
    "where_is_order": ["new phrase 1", "new phrase 2", ...],
    "cancel_request": ["new phrase 1", ...],
    ...
  },
  "new_categories": [
    {
      "category": "...",
      "name": "...",
      "description": "...",
      "auto_tag": "...",
      "phrases": ["...", "..."]
    }
  ]
}`
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Claude bootstrap error:", err);
    return NextResponse.json({ error: "AI analysis failed" }, { status: 502 });
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return NextResponse.json({ error: "Could not parse AI response", raw: text.slice(0, 500) }, { status: 500 });
  }

  const result = JSON.parse(jsonMatch[0]);
  let updatedCount = 0;
  let newCount = 0;

  // Expand existing patterns with new phrases
  for (const [category, newPhrases] of Object.entries(result.expanded_phrases || {})) {
    const existing = existingPatterns?.find(p => p.category === category);
    if (!existing) continue;

    const { data: pattern } = await admin
      .from("smart_patterns")
      .select("id, phrases")
      .eq("category", category)
      .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
      .eq("active", true)
      .single();

    if (pattern) {
      const currentPhrases = (pattern.phrases as string[]) || [];
      const combined = [...new Set([...currentPhrases, ...(newPhrases as string[])])];
      await admin.from("smart_patterns").update({
        phrases: combined,
        embedding: null, // Clear embedding so it gets regenerated
      }).eq("id", pattern.id);
      updatedCount++;
    }
  }

  // Create new categories
  for (const cat of result.new_categories || []) {
    const { data: newPattern } = await admin.from("smart_patterns").insert({
      workspace_id: null, // global
      category: cat.category,
      name: cat.name,
      description: cat.description,
      phrases: cat.phrases,
      auto_tag: cat.auto_tag,
      match_target: "both",
      priority: 45,
      source: "seed",
    }).select("id").single();

    if (newPattern) {
      newCount++;
      // Generate embedding for the new pattern
      await generatePatternEmbedding(newPattern.id, cat.name, cat.description, cat.phrases);
    }
  }

  return NextResponse.json({
    updated_categories: updatedCount,
    new_categories: newCount,
    expanded_phrases: result.expanded_phrases,
    new_category_names: (result.new_categories || []).map((c: { name: string }) => c.name),
  });
}
