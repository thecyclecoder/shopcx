// Embedding generation for semantic pattern matching
// Supports: OpenAI (text-embedding-3-small), Voyage AI, or HuggingFace
// Configure via OPENAI_API_KEY, VOYAGE_API_KEY, or HF_TOKEN env vars

export async function generateEmbedding(text: string, dimensions: number = 384): Promise<number[] | null> {
  const cleanText = text.slice(0, 2000);

  // Try OpenAI first (cheapest, most reliable)
  if (process.env.OPENAI_API_KEY) {
    return openaiEmbed(cleanText, dimensions);
  }

  // Try Voyage AI
  if (process.env.VOYAGE_API_KEY) {
    return voyageEmbed(cleanText);
  }

  // Try HuggingFace
  if (process.env.HF_TOKEN) {
    return hfEmbed(cleanText);
  }

  console.warn("No embedding API key configured (OPENAI_API_KEY, VOYAGE_API_KEY, or HF_TOKEN)");
  return null;
}

// 1536-dim embeddings for KB chunks and macros
export async function generateEmbedding1536(text: string): Promise<number[] | null> {
  return generateEmbedding(text, 1536);
}

async function openaiEmbed(text: string, dimensions: number = 384): Promise<number[] | null> {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
        dimensions,
      }),
    });
    if (!res.ok) { console.error("OpenAI embed error:", await res.text()); return null; }
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch (err) { console.error("OpenAI embed failed:", err); return null; }
}

async function voyageEmbed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "voyage-3-lite", input: text, input_type: "document" }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch { return null; }
}

async function hfEmbed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch("https://router.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && typeof data[0] === "number") return data;
    if (Array.isArray(data) && Array.isArray(data[0])) return data[0];
    return null;
  } catch { return null; }
}

// Generate and store embedding for a smart pattern
export async function generatePatternEmbedding(
  patternId: string,
  name: string,
  description: string | null,
  phrases: string[],
): Promise<boolean> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  const embeddingText = [name, description || "", ...phrases].join(". ");
  const embedding = await generateEmbedding(embeddingText);
  if (!embedding) return false;

  const { error } = await admin
    .from("smart_patterns")
    .update({ embedding: JSON.stringify(embedding), embedding_text: embeddingText })
    .eq("id", patternId);

  if (error) { console.error("Store embedding error:", error.message); return false; }
  return true;
}

// Generate embeddings for ALL patterns missing one
export async function generateAllPatternEmbeddings(): Promise<number> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  const { data: patterns } = await admin
    .from("smart_patterns")
    .select("id, name, description, phrases")
    .eq("active", true)
    .is("embedding", null);

  if (!patterns || patterns.length === 0) return 0;

  let generated = 0;
  for (const p of patterns) {
    const ok = await generatePatternEmbedding(p.id, p.name, p.description, (p.phrases as string[]) || []);
    if (ok) generated++;
    await new Promise(r => setTimeout(r, 200));
  }
  return generated;
}
