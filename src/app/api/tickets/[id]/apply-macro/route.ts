import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

// POST: AI personalizes a macro for a ticket's customer context
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
  const { macro_id } = body;

  if (!macro_id) return NextResponse.json({ error: "macro_id required" }, { status: 400 });

  // Get macro
  const { data: macro } = await admin
    .from("macros")
    .select("id, name, body_text")
    .eq("id", macro_id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!macro) return NextResponse.json({ error: "Macro not found" }, { status: 404 });

  // Get ticket + customer context
  const { data: ticket } = await admin
    .from("tickets")
    .select("*, customers(id, email, first_name, last_name, phone, subscription_status, total_orders, ltv_cents)")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  // Get channel config for personality
  const channel = ticket.channel || "email";
  const { data: channelConfig } = await admin
    .from("ai_channel_config")
    .select("personality_id, instructions, max_response_length")
    .eq("workspace_id", workspaceId)
    .eq("channel", channel)
    .single();

  let personality: { tone: string; style_instructions: string; sign_off: string | null; greeting: string | null } | null = null;
  if (channelConfig?.personality_id) {
    const { data: p } = await admin.from("ai_personalities").select("tone, style_instructions, sign_off, greeting").eq("id", channelConfig.personality_id).single();
    personality = p;
  }

  // Get conversation history
  const { data: messages } = await admin
    .from("ticket_messages")
    .select("direction, body, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(10);

  // Build personalization prompt
  const customer = ticket.customers as { first_name: string | null; last_name: string | null; email: string; subscription_status: string; total_orders: number; ltv_cents: number } | null;

  const parts: string[] = [];
  parts.push("Personalize this macro response for the customer. Keep the core message but adapt the tone and include relevant customer details.");
  parts.push("\nFORMATTING RULES:");
  parts.push("- Maximum 2-3 sentences per paragraph. Each new point or shift in direction gets its own paragraph.");
  parts.push("- Separate paragraphs with a blank line.");
  parts.push("- Do NOT use markdown (no **, __, bullet points, headers). Plain text only.");
  parts.push("- Your response should NEVER be longer than the original macro. Match its length. If the macro is 3 sentences, your personalized version should be about 3 sentences.");
  parts.push("- Do NOT add extra explanation, caveats, or filler that wasn't in the original macro.");
  if (channel === "chat" || channel === "sms" || channel === "meta_dm") {
    parts.push(`- CHANNEL: This is ${channel}. Keep it shorter than the macro — 1-2 sentences max. Conversational and direct.`);
  }
  if (personality) {
    parts.push(`\nTone: ${personality.tone}`);
    if (personality.style_instructions) parts.push(`Style: ${personality.style_instructions}`);
    if (personality.greeting) parts.push(`Start with a greeting like: ${personality.greeting}`);
    if (personality.sign_off) parts.push(`End with: ${personality.sign_off}`);
  }
  if (channelConfig?.instructions) parts.push(`\nChannel instructions: ${channelConfig.instructions}`);
  if (customer) {
    parts.push(`\nCustomer: ${customer.first_name || ""} ${customer.last_name || ""} (${customer.email})`);
    if (customer.total_orders) parts.push(`Orders: ${customer.total_orders}, LTV: $${(customer.ltv_cents / 100).toFixed(0)}`);
    if (customer.subscription_status !== "none") parts.push(`Subscription: ${customer.subscription_status}`);
  }
  if (messages?.length) {
    parts.push("\nConversation:");
    for (const m of messages.slice(-5)) {
      parts.push(`${m.direction === "inbound" ? "Customer" : "Agent"}: ${(m.body || "").slice(0, 300)}`);
    }
  }
  parts.push(`\n--- MACRO TO PERSONALIZE ---\n${macro.body_text}\n--- END MACRO ---`);
  parts.push("\nReturn ONLY the personalized response text, nothing else.");

  // Call Claude
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "No API key" }, { status: 500 });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: parts.join("\n"),
        messages: [{ role: "user", content: `Personalize this macro "${macro.name}" for the customer.` }],
      }),
    });

    if (!res.ok) {
      return NextResponse.json({ error: "AI call failed" }, { status: 500 });
    }

    const data = await res.json();
    const personalized = data.content?.[0]?.text || macro.body_text;

    return NextResponse.json({
      personalized,
      macro_id: macro.id,
      macro_name: macro.name,
      original: macro.body_text,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
