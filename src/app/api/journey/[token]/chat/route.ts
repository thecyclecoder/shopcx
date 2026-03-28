import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateOpenEndedResponse } from "@/lib/remedy-selector";

/**
 * POST: Open-ended AI conversation for cancel journey.
 * Used when customer selects "just need a break", "something else", or "reached goals".
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, customer_id, config_snapshot, status, responses")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (session.status === "completed") return NextResponse.json({ error: "already_completed" }, { status: 400 });

  const body = await request.json();
  const { message, history } = body as {
    message: string;
    history: { role: "user" | "assistant"; content: string }[];
  };

  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });

  const config = session.config_snapshot as {
    metadata?: {
      subscriptions?: { items: { title: string }[] }[];
    };
  };
  const metadata = config.metadata || {};
  const responses = (session.responses || {}) as Record<string, { value: string }>;
  const cancelReason = responses.cancel_reason?.value || "something_else";

  // Get customer context
  const { data: customer } = await admin
    .from("customers")
    .select("retention_score")
    .eq("id", session.customer_id)
    .single();

  const { data: orders } = await admin
    .from("orders")
    .select("id, total_price_cents")
    .eq("customer_id", session.customer_id)
    .eq("workspace_id", session.workspace_id);

  const totalOrders = orders?.length || 0;
  const ltv = orders?.reduce((sum, o) => sum + (o.total_price_cents || 0), 0) || 0;

  const { data: sub } = await admin
    .from("subscriptions")
    .select("created_at")
    .eq("customer_id", session.customer_id)
    .eq("workspace_id", session.workspace_id)
    .eq("status", "active")
    .limit(1)
    .single();

  const subAge = sub?.created_at
    ? Math.floor((Date.now() - new Date(sub.created_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const products = (metadata.subscriptions || []).flatMap(s => s.items.map(i => i.title));

  const turnCount = (history || []).filter(h => h.role === "assistant").length;

  // Check if AI should accept cancellation (max 3 turns)
  const response = await generateOpenEndedResponse(
    session.workspace_id,
    cancelReason,
    message,
    history || [],
    {
      ltv_cents: ltv,
      retention_score: customer?.retention_score || 50,
      subscription_age_days: subAge,
      total_orders: totalOrders,
      products,
    },
    products,
  );

  // Detect if AI accepted the cancellation
  const acceptPhrases = ["let me go ahead and cancel", "let me cancel", "i completely understand", "i'll cancel", "i understand. let me"];
  const aiAccepted = acceptPhrases.some(p => response.toLowerCase().includes(p));

  return NextResponse.json({
    response,
    ai_accepted_cancel: aiAccepted,
    turn_count: turnCount + 1,
    max_turns: 3,
  });
}
