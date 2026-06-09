/**
 * POST /api/popup/outcome  (storefront-mvp Phase 4b — outcome logging)
 *
 * Patches the popup_decisions outcome funnel as the session progresses:
 * shown → engaged (interacted with the popup) → converted (lead captured).
 * Logged from day one so "smart" can be proven against a dumb timer and
 * the Haiku prompt tuned. Idempotent flag-flips; never un-sets a flag.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    workspace_id?: string;
    anonymous_id?: string;
    shown?: boolean;
    engaged?: boolean;
    converted?: boolean;
  };
  if (!body.workspace_id || !body.anonymous_id) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const admin = createAdminClient();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.shown) updates.shown = true;
  if (body.engaged) updates.engaged = true;
  if (body.converted) updates.converted = true;

  await admin
    .from("popup_decisions")
    .update(updates)
    .eq("workspace_id", body.workspace_id)
    .eq("anonymous_id", body.anonymous_id)
    .then(() => undefined, () => undefined);

  return new NextResponse(null, { status: 204 });
}
