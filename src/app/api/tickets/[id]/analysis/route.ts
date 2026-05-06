import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET — latest analysis for the ticket + cumulative cost
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: ticketId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "no_workspace" }, { status: 400 });

  const admin = createAdminClient();

  const { data: latest } = await admin.from("ticket_analyses")
    .select("id, score, admin_score, admin_score_reason, admin_corrected_at, issues, action_items, summary, model, cost_cents, ai_message_count, window_start, window_end, created_at, trigger")
    .eq("ticket_id", ticketId)
    .eq("workspace_id", workspaceId)
    .order("window_end", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Cumulative cost across all AI calls tagged to this ticket
  // (analysis + conversation generation)
  const { data: usageRows } = await admin.from("ai_token_usage")
    .select("model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, purpose")
    .eq("ticket_id", ticketId);

  const { usageCostCents } = await import("@/lib/ai-usage");
  let conversationCostCents = 0;
  let analysisCostCents = 0;
  for (const r of usageRows || []) {
    const c = usageCostCents(r.model, {
      input_tokens: r.input_tokens || 0,
      output_tokens: r.output_tokens || 0,
      cache_creation_tokens: r.cache_creation_tokens || 0,
      cache_read_tokens: r.cache_read_tokens || 0,
    });
    if (r.purpose === "ticket_analysis") analysisCostCents += c;
    else conversationCostCents += c;
  }

  const { count: historyCount } = await admin.from("ticket_analyses")
    .select("id", { count: "exact", head: true })
    .eq("ticket_id", ticketId)
    .eq("workspace_id", workspaceId);

  return NextResponse.json({
    latest,
    history_count: historyCount || 0,
    cost: {
      conversation_cents: conversationCostCents,
      analysis_cents: analysisCostCents,
      total_cents: conversationCostCents + analysisCostCents,
    },
  });
}
