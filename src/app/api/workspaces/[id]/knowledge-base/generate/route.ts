import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SONNET_MODEL } from "@/lib/ai-models";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  void (await params);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Anthropic API key not configured" }, { status: 500 });
  }

  const body = await request.json();
  const { topic, raw_material, category, product_id } = body as {
    topic: string;
    raw_material: string;
    category?: string;
    product_id?: string;
  };

  if (!topic || !raw_material) {
    return NextResponse.json({ error: "topic and raw_material are required" }, { status: 400 });
  }

  const systemPrompt = `You are a knowledge base article writer for a health supplement and superfood company. Write clear, helpful articles that customers can understand. Use a warm, professional tone.

Format the article with:
- A clear title
- Short paragraphs (2-3 sentences each)
- Subheadings where appropriate (use <h2> and <h3> tags)
- No markdown — use HTML tags for formatting
- Include an excerpt (1-2 sentence summary)`;

  const userPrompt = `Write a knowledge base article about: ${topic}

Use the following raw information as source material:
${raw_material}

Return JSON only, no other text:
{
  "title": "...",
  "content": "...(plain text version)...",
  "content_html": "...(HTML formatted version)...",
  "excerpt": "...(1-2 sentence summary)...",
  "slug": "...(url-friendly-slug)..."
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `AI generation failed: ${err}` }, { status: 502 });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";

    // Extract JSON from response (handle potential markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Failed to parse AI response" }, { status: 502 });
    }

    const generated = JSON.parse(jsonMatch[0]);

    return NextResponse.json({
      title: generated.title || topic,
      content: generated.content || "",
      content_html: generated.content_html || "",
      excerpt: generated.excerpt || "",
      slug: generated.slug || topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      category: category || "general",
      product_id: product_id || null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Generation failed: ${err instanceof Error ? err.message : "Unknown error"}` },
      { status: 500 }
    );
  }
}
