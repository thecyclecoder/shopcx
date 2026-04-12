import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are a support AI coach. An admin is reviewing a ticket where the AI (you) handled something incorrectly. They're telling you what should have happened differently.

Your job:
1. Understand what went wrong
2. Determine if this can be fixed with a PROMPT RULE (a text instruction added to the AI's prompt database) or if it requires an ARCHITECTURE CHANGE (code modification)
3. For prompt rules: propose a clear, specific rule with a title. Ask the admin to verify before they save it.
4. For architecture changes: describe what needs to change in the codebase.
5. If you're not sure what the admin wants, ask a clarifying question.

ALWAYS verify before finalizing. Show your proposed rule and ask "Does this look right? Feel free to edit it before saving."

Return JSON:
{
  "type": "prompt" | "architecture" | "question",
  "message": "your conversational response to the admin",
  "proposed_rule": { "title": "...", "content": "...", "category": "rule" },
  "architecture_description": "..."
}

Only include proposed_rule if type is "prompt". Only include architecture_description if type is "architecture".
Category for proposed_rule should be one of: rule, approach, knowledge, tool_hint.`;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI not configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Verify admin/owner role
  const { data: member } = await admin
    .from("workspace_members")
    .select("workspace_role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.workspace_role)) {
    return NextResponse.json({ error: "Admin or owner role required" }, { status: 403 });
  }

  const body = await request.json();
  const { message, conversationHistory } = body as {
    message: string;
    conversationHistory: { role: "user" | "assistant"; content: string }[];
  };

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // Get ticket details
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, tags, status, channel, customer_email, handled_by, ai_turn_count, escalation_reason")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  // Get ticket messages
  const { data: messages } = await admin
    .from("ticket_messages")
    .select("direction, visibility, author_type, body, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(50);

  // Get customer info if available
  let customerInfo = "";
  if (ticket.customer_email) {
    const { data: cust } = await admin
      .from("customers")
      .select("first_name, last_name, email, subscription_status, retention_score, total_orders, ltv")
      .eq("workspace_id", workspaceId)
      .eq("email", ticket.customer_email)
      .limit(1)
      .single();
    if (cust) {
      customerInfo = `Customer: ${cust.first_name || ""} ${cust.last_name || ""} (${cust.email}), Subscription: ${cust.subscription_status || "none"}, Retention: ${cust.retention_score || 0}, Orders: ${cust.total_orders || 0}, LTV: $${cust.ltv || 0}`;
    }
  }

  // Build ticket context
  const ticketContext = [
    `Subject: ${ticket.subject}`,
    `Status: ${ticket.status}`,
    `Channel: ${ticket.channel}`,
    `Tags: ${(ticket.tags || []).join(", ") || "none"}`,
    `Handled by: ${ticket.handled_by || "unassigned"}`,
    `AI turns: ${ticket.ai_turn_count || 0}`,
    ticket.escalation_reason ? `Escalation reason: ${ticket.escalation_reason}` : null,
    customerInfo || null,
    "",
    "--- Ticket Messages ---",
    ...(messages || []).map(m => {
      const prefix = m.author_type === "ai" ? "[AI]" : m.author_type === "system" ? "[System]" : m.direction === "inbound" ? "[Customer]" : "[Agent]";
      const vis = m.visibility === "internal" ? " (internal note)" : "";
      return `${prefix}${vis}: ${m.body?.replace(/<[^>]+>/g, " ").slice(0, 500)}`;
    }),
  ].filter(Boolean).join("\n");

  // Build Claude messages
  const claudeMessages: { role: "user" | "assistant"; content: string }[] = [];

  // Add conversation history
  if (conversationHistory && conversationHistory.length > 0) {
    for (const h of conversationHistory) {
      claudeMessages.push({ role: h.role, content: h.content });
    }
  }

  // Add current message
  claudeMessages.push({
    role: "user",
    content: message,
  });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: `${SYSTEM_PROMPT}\n\n--- TICKET CONTEXT ---\n${ticketContext}`,
        messages: claudeMessages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Anthropic API error:", errText);
      return NextResponse.json({ error: "AI request failed" }, { status: 502 });
    }

    const data = await res.json();
    const rawText = data.content?.[0]?.text || "";

    // Try to parse as JSON
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return NextResponse.json(parsed);
      } catch {
        // Fall through to text response
      }
    }

    // If not valid JSON, treat as a question
    return NextResponse.json({
      type: "question",
      message: rawText,
    });
  } catch (err) {
    console.error("Improve endpoint error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
