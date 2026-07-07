import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Same idiom as the other lib UUID validators (pricing.ts, migration-audit.ts, …) —
// no shared helper exists; each site inlines its own. Anchored so the whole path segment
// must match, closing the injection sink flagged by the pre-merge review.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET — list proposed handler aliases for a workspace, filtered by status.
// Also returns the currently-active alias catalog (globals + workspace
// overrides) so the admin surface can render both together.
//
// Fix 2 of confidence-gated-problem-lockin-and-selective-clarify (Phase 4) —
// three coupled hardening changes at the SAME site, all guarding the same
// admin-client reach. Each is cited on its guard line so the audit trail is
// legible:
//   (a) UUID_RE on `workspaceId` — closes `sec:injection:…:31`. The path
//       segment `params.id` is user-controlled; without validation, a comma
//       (URL-encoded as %2C) survives Next.js decoding and gets interpolated
//       into the PostgREST `.or()` DSL string below, letting an authenticated
//       attacker smuggle additional filter atoms into the OR expression on
//       action_handler_aliases (service-role query, RLS bypassed).
//   (b) workspace_members lookup before ANY admin-client read — closes
//       `sec:authz_rls:…:20` + `sec:unsafe_admin_client:…:20`. Matches the
//       sibling PATCH handler's pattern at
//       [proposalId]/route.ts:26-30 (its role check is stricter — owner/admin;
//       here we only enforce membership so any workspace member can view the
//       catalog, matching this GET's read-only surface).
//   (c) `.in('workspace_id', [null, workspaceId])` replaces the interpolated
//       `.or(…)` DSL — no user-controlled value ever reaches the PostgREST
//       filter DSL, defense-in-depth on top of (a).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;

  // Fix 2 (a) — reject any non-UUID path segment BEFORE it can reach the DSL string.
  if (!UUID_RE.test(workspaceId)) {
    return NextResponse.json({ error: "invalid_workspace_id" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Fix 2 (b) — verify the caller is a member of the URL-provided workspace BEFORE
  // any service-role SELECT runs (createAdminClient bypasses RLS). Matches the
  // sibling PATCH handler at [proposalId]/route.ts:26-30 (that handler's stricter
  // role gate — owner/admin only — is preserved on the mutating path; this GET
  // opens the read-only surface to any workspace member).
  const { data: member } = await admin.from("workspace_members")
    .select("user_id").eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const status = req.nextUrl.searchParams.get("status"); // 'pending' | 'approved' | 'declined' | null (= all)

  let q = admin.from("proposed_action_aliases")
    .select("id, source_type, ticket_id, occurrences, first_seen, last_seen, suggested_target, suggested_at, suggested_model, suggested_reasoning, status, reviewed_at, created_at")
    .eq("workspace_id", workspaceId)
    .order("last_seen", { ascending: false });

  if (status) q = q.eq("status", status);

  const { data: proposals, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Fix 2 (c) — `.in('workspace_id', [null, workspaceId])` replaces the interpolated
  // `.or('workspace_id.is.null,workspace_id.eq.${workspaceId}')` DSL string.
  // No user-controlled value ever reaches the PostgREST filter DSL — the client
  // library parameterizes both entries in the array literal.
  const { data: aliases } = await admin.from("action_handler_aliases")
    .select("id, workspace_id, source_type, target_type, active, created_at")
    .in("workspace_id", [null, workspaceId])
    .order("source_type", { ascending: true });

  return NextResponse.json({ proposals: proposals || [], aliases: aliases || [] });
}
