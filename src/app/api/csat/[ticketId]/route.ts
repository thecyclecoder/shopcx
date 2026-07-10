/**
 * POST /api/csat/[ticketId]
 *
 * Two-path submit:
 *   { token, action: "reopen", reason }    — customer says NO, issue
 *     not resolved. Reopens the ticket with their reason as a new
 *     inbound message. No CSAT recorded; no points.
 *
 *   { token, action: "rate", rating, comment? } — customer says YES,
 *     issue resolved. Records the CSAT, awards 500 points (once).
 *
 * Idempotent on the rating path — re-submits update the existing row.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createHmac } from "crypto";

const CSAT_POINTS = 500;

function expectedToken(ticketId: string): string {
  const secret = process.env.ENCRYPTION_KEY || "fallback";
  return createHmac("sha256", secret).update(ticketId).digest("hex").slice(0, 32);
}

/**
 * GET — read existing CSAT for this ticket (if any).
 * Returns { existing: null } when nothing has been submitted yet, OR
 * { existing: { rating, comment, submitted_at, points_awarded } }.
 *
 * Used by the mini-site on load so a refresh after submitting doesn't
 * show the rating form again — instead we show a "thanks, you already
 * rated this" view with the rating + comment.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  const { ticketId } = await params;
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  if (!token || token !== expectedToken(ticketId)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data } = await admin
    .from("ticket_csat")
    .select("rating, comment, submitted_at, points_awarded")
    .eq("ticket_id", ticketId)
    .maybeSingle();
  return NextResponse.json({ existing: data || null });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  const { ticketId } = await params;
  const body = await request.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!token || token !== expectedToken(ticketId)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, workspace_id, customer_id, subject, status")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  const action = String(body.action || "");
  const now = new Date().toISOString();

  if (action === "reopen") {
    const reason = (typeof body.reason === "string" ? body.reason.trim() : "").slice(0, 4000);
    if (!reason) {
      return NextResponse.json({ error: "reason required" }, { status: 400 });
    }
    // Insert the customer's note as an inbound external message and
    // reopen the ticket so an agent picks it up. Tag for analytics.
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "inbound",
      visibility: "external",
      author_type: "customer",
      body: `<p>${reason.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`,
      created_at: now,
    });
    await admin.from("tickets").update({
      status: "open",
      closed_at: null,
      last_customer_reply_at: now,
      updated_at: now,
    }).eq("id", ticketId);
    const { addTicketTag } = await import("@/lib/ticket-tags");
    await addTicketTag(ticketId, "csat:reopened");
    return NextResponse.json({ ok: true, action: "reopened" });
  }

  if (action === "rate") {
    const rating = Number(body.rating);
    const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 2000) || null : null;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return NextResponse.json({ error: "rating must be 1-5" }, { status: 400 });
    }

    const { data: existing } = await admin
      .from("ticket_csat")
      .select("id, points_awarded")
      .eq("ticket_id", ticketId)
      .maybeSingle();

    let csatId: string;
    if (existing) {
      await admin.from("ticket_csat").update({
        rating, comment, submitted_at: now, updated_at: now,
        // The resolved-gate guarantees this — we set it here so the
        // dashboard can read it without a separate classification step.
        resolution_category: "resolved",
      }).eq("id", existing.id);
      csatId = existing.id as string;
    } else {
      const { data: ins, error } = await admin.from("ticket_csat").insert({
        workspace_id: ticket.workspace_id,
        ticket_id: ticketId,
        customer_id: ticket.customer_id,
        rating, comment,
        resolution_category: "resolved",
        submitted_at: now,
      }).select("id").single();
      if (error || !ins) return NextResponse.json({ error: error?.message || "Insert failed" }, { status: 500 });
      csatId = ins.id;
    }

    // Award points exactly once.
    let awarded = 0;
    if (!existing?.points_awarded && ticket.customer_id) {
      try {
        const { getMemberByCustomerId, earnPoints } = await import("@/lib/loyalty");
        const member = await getMemberByCustomerId(ticket.customer_id, ticket.workspace_id);
        if (member) {
          await earnPoints(member, CSAT_POINTS, null, `Completed CSAT survey for ticket ${ticketId.slice(0, 8)}`);
          await admin.from("ticket_csat").update({
            points_awarded: CSAT_POINTS, points_awarded_at: now,
          }).eq("id", csatId);
          awarded = CSAT_POINTS;
        }
      } catch (err) {
        console.warn("CSAT points award failed:", err);
      }
    }

    // A ≤3 rating on a ticket the customer confirmed RESOLVED is an end-result miss the cheap triage
    // pass never saw (it runs before the survey). Force a DEEP Cora session directly via the "low_csat"
    // trigger — it bypasses the cheap pass (only "auto_close" runs it) and re-grades the handling with
    // the customer's own dissatisfaction as ground truth. Best-effort + fire-and-forget: a grading
    // enqueue must never fail the customer's survey submit.
    if (rating <= 3) {
      try {
        const { analyzeTicket } = await import("@/lib/ticket-analyzer");
        await analyzeTicket(ticketId, "low_csat");
      } catch (err) {
        console.warn("[csat] low-CSAT Cora enqueue failed:", err);
      }
    }

    return NextResponse.json({ ok: true, action: "rated", points_awarded: awarded });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
