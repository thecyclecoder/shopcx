import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { SONNET_MODEL } from "@/lib/ai-models";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// POST: Submit feedback when an agent removes a smart tag
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const body = await request.json();
  const { tag, reason } = body;

  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });

  // Find the pattern that auto-tags with this smart tag
  const rawTag = tag.startsWith("smart:") ? tag.slice(6) : tag;
  const { data: pattern } = await admin
    .from("smart_patterns")
    .select("id, name, category, phrases")
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .eq("auto_tag", rawTag)
    .single();

  // Get ticket subject + first customer message for AI context
  const { data: ticket } = await admin.from("tickets").select("subject").eq("id", ticketId).single();
  const { data: messages } = await admin
    .from("ticket_messages")
    .select("body, direction, author_type")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(3);

  const customerMessage = messages?.find(m => m.direction === "inbound");
  const plainBody = (customerMessage?.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);

  // Save feedback record
  const feedbackRecord: Record<string, unknown> = {
    workspace_id: workspaceId,
    ticket_id: ticketId,
    pattern_id: pattern?.id || null,
    tag_removed: tag,
    agent_reason: reason || null,
    created_by: user.id,
  };

  // If we have an API key and a reason, ask Claude to analyze
  if (ANTHROPIC_API_KEY && reason && pattern) {
    try {
      const prompt = `A customer support agent removed an auto-applied tag from a ticket. Analyze whether the pattern that applied this tag needs adjustment.

PATTERN: "${pattern.name}" (category: ${pattern.category})
PHRASES THAT TRIGGER THIS TAG: ${JSON.stringify(pattern.phrases)}

TICKET:
Subject: ${ticket?.subject || "(no subject)"}
Customer message: ${plainBody}

AGENT'S REASON FOR REMOVING THE TAG: "${reason}"

Analyze and respond in JSON:
{
  "assessment": "false_positive" | "edge_case" | "correct_tag" | "needs_new_category",
  "explanation": "Why the pattern matched incorrectly or correctly",
  "suggested_action": "remove_phrase" | "add_negative_phrase" | "no_change" | "new_category",
  "phrase_to_remove": "the phrase that caused the false positive (if applicable)",
  "suggested_negative": "a negative phrase to add to prevent this (if applicable)"
}`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: SONNET_MODEL,
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.content?.[0]?.text || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          feedbackRecord.ai_analysis = JSON.parse(jsonMatch[0]);
        }
      }
    } catch (err) {
      console.error("AI feedback analysis error:", err);
    }
  }

  const { data: feedback } = await admin
    .from("pattern_feedback")
    .insert(feedbackRecord)
    .select()
    .single();

  return NextResponse.json(feedback);
}
