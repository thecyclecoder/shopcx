/**
 * GET /api/developer/agents/cs-director/digests/latest — the founder's read for
 * /dashboard/agents/cs-director/digests. Returns the LATEST `cs_director_digests` row for the
 * caller's workspace, with its storylines array and reply state.
 *
 * Phase 2 of [[docs/brain/specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]].
 *
 * Owner-gated (mirrors POST /api/developer/agents/autonomy): the digests are the CS director's
 * founder-facing surface, so a non-owner reading them isn't a leak per se, but the paired reply
 * endpoint IS owner-gated and we want the two to match. Returns `{ digest: null }` when no digest
 * has been composed yet (the founder sees a "no digests yet" state — never an error).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can view CS Director digests" }, { status: 403 });
  }

  const { data, error } = await admin
    .from("cs_director_digests")
    .select("id, digest_period_start, digest_period_end, storylines, created_at, ceo_replied_at, ceo_reply_action")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    return NextResponse.json({ error: "Failed to read digest", detail: error.message }, { status: 500 });
  }
  const digest = Array.isArray(data) && data.length > 0 ? data[0] : null;
  return NextResponse.json({ digest });
}
