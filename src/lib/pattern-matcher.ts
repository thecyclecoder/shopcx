import { createAdminClient } from "@/lib/supabase/admin";

// ── Types ──

export interface PatternMatch {
  patternId: string;
  category: string;
  name: string;
  autoTag: string | null;
  autoAction: string | null;
  confidence: number;        // 0.0 - 1.0
  method: "keyword" | "embedding" | "ai";
  matchedPhrase?: string;    // only for keyword matches
}

interface SmartPattern {
  id: string;
  workspace_id: string | null;
  category: string;
  name: string;
  phrases: string[];
  description: string | null;
  match_target: string;
  priority: number;
  auto_tag: string | null;
  auto_action: string | null;
  active: boolean;
}

// ── Text cleaning ──

function cleanText(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^\w\s'''-]/g, "")
    .split(/(?:sent from|get outlook|on .+ wrote:|from:|----)/)[0]
    .trim();
}

// ── Main 3-layer classifier ──

export async function matchPatterns(
  workspaceId: string,
  subject: string | null,
  body: string,
): Promise<PatternMatch | null> {
  const admin = createAdminClient();

  // Load patterns + overrides
  const { data: allPatterns } = await admin
    .from("smart_patterns")
    .select("*")
    .eq("active", true)
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .order("priority", { ascending: false });

  if (!allPatterns || allPatterns.length === 0) return null;

  const { data: overrides } = await admin
    .from("workspace_pattern_overrides")
    .select("pattern_id, enabled")
    .eq("workspace_id", workspaceId);

  const overrideMap = new Map<string, boolean>();
  for (const o of overrides || []) overrideMap.set(o.pattern_id, o.enabled);

  const patterns = (allPatterns as SmartPattern[]).filter((p) => {
    if (p.workspace_id) return true;
    return overrideMap.get(p.id) !== false;
  });

  const cleanedSubject = subject ? cleanText(subject) : "";
  const cleanedBody = cleanText(body);
  const fullText = `${cleanedSubject} ${cleanedBody}`;

  // ═══ LAYER 1: Keyword matching (instant, deterministic) ═══
  const keywordMatch = matchKeywords(patterns, cleanedSubject, cleanedBody);
  if (keywordMatch) return keywordMatch;

  // ═══ LAYER 2: Embedding similarity (fast, semantic) ═══
  const embeddingMatch = await matchEmbeddings(admin, workspaceId, fullText);
  if (embeddingMatch) return embeddingMatch;

  // ═══ LAYER 3: Claude Haiku fallback (slow, expensive, last resort) ═══
  const aiMatch = await matchWithAI(patterns, subject, cleanedBody);
  if (aiMatch) return aiMatch;

  return null;
}

// ── Layer 1: Keyword matching ──

function matchKeywords(
  patterns: SmartPattern[],
  cleanedSubject: string,
  cleanedBody: string,
): PatternMatch | null {
  for (const pattern of patterns) {
    const phrases = (pattern.phrases || []) as string[];
    const textToCheck = pattern.match_target === "subject"
      ? cleanedSubject
      : pattern.match_target === "body"
        ? cleanedBody
        : `${cleanedSubject} ${cleanedBody}`;

    for (const phrase of phrases) {
      if (textToCheck.includes(phrase.toLowerCase())) {
        return {
          patternId: pattern.id,
          category: pattern.category,
          name: pattern.name,
          autoTag: pattern.auto_tag ? `smart:${pattern.auto_tag}` : null,
          autoAction: pattern.auto_action,
          confidence: 1.0,
          method: "keyword",
          matchedPhrase: phrase,
        };
      }
    }
  }
  return null;
}

// ── Layer 2: Embedding similarity via pgvector ──

async function matchEmbeddings(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  text: string,
): Promise<PatternMatch | null> {
  try {
    const { generateEmbedding } = await import("@/lib/embeddings");
    const embedding = await generateEmbedding(text);
    if (!embedding) return null;

    const { data: matches } = await admin.rpc("match_pattern_embeddings", {
      query_embedding: JSON.stringify(embedding),
      ws_id: workspaceId,
      match_threshold: 0.65,
      match_count: 3,
    });

    if (!matches || matches.length === 0) return null;

    const best = matches[0];
    if (best.similarity >= 0.65) {
      return {
        patternId: best.id,
        category: best.category,
        name: best.name,
        autoTag: best.auto_tag ? `smart:${best.auto_tag}` : null,
        autoAction: best.auto_action,
        confidence: Math.round(best.similarity * 100) / 100,
        method: "embedding",
      };
    }
  } catch (err) {
    console.error("Embedding layer error:", err);
  }
  return null;
}

// ── Layer 3: Claude Haiku fallback ──

async function matchWithAI(
  patterns: SmartPattern[],
  subject: string | null,
  cleanedBody: string,
): Promise<PatternMatch | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const tagList = patterns.map(p =>
    `- ${p.category} (tag: ${p.auto_tag || "none"}): ${p.name}. ${p.description || ""}`
  ).join("\n");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s hard timeout

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `Classify this customer support ticket into one of these categories. Return JSON only.

CATEGORIES:
${tagList}

TICKET:
Subject: ${subject || "(none)"}
Body: ${cleanedBody.slice(0, 1000)}

Return: {"category": "category_name", "confidence": 0.0-1.0}
If no category fits with >0.6 confidence, return: {"category": null, "confidence": 0}`
        }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]);
    if (!result.category || result.confidence < 0.6) return null;

    // Find the matching pattern
    const match = patterns.find(p => p.category === result.category);
    if (!match) return null;

    return {
      patternId: match.id,
      category: match.category,
      name: match.name,
      autoTag: match.auto_tag ? `smart:${match.auto_tag}` : null,
      autoAction: match.auto_action,
      confidence: Math.round(result.confidence * 100) / 100,
      method: "ai",
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn("AI classification timed out (5s)");
    } else {
      console.error("AI classification error:", err);
    }
    return null;
  }
}
