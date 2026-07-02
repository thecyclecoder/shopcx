/**
 * /api/developer/spec-test/human-queue — the box spec-test agent's human-test queue (spec-test-agent
 * Phase 2). Owner-gated + workspace-scoped.
 *
 *   GET  → { items, regressions, counts } — every `needs_human` check across the latest run of every
 *          shipped-but-unverified spec, joined to the owner's resolutions, plus regressions (auto-`fail`s).
 *          Drives the queue page + the sidebar count badge.
 *   POST → { slug, check_key, check_text, resolution } records an owner resolution (verified｜failed｜
 *          dismissed); { slug, check_key, clear: true } re-opens it. The agent NEVER writes here.
 *
 * Read-only over prod state apart from the owner's own resolution rows. See docs/brain/specs/spec-test-agent.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getHumanTestQueue,
  upsertHumanCheckResolution,
  clearHumanCheckResolution,
  checkKey,
  isHumanResolution,
  autoFoldVerifiedSpecs,
} from "@/lib/spec-test-runs";
import { reflectSpecGreenChecks } from "@/lib/spec-green-writeback";


const isSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9-]+$/i.test(s);

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "Only the workspace owner can view the human-test queue" }, { status: 403 }) };
  }
  return { user, workspaceId, admin };
}

export async function GET() {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const queue = await getHumanTestQueue(auth.workspaceId);
  return NextResponse.json(queue);
}

export async function POST(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { user, workspaceId } = auth;

  const body = (await request.json().catch(() => ({}))) as {
    slug?: string;
    check_key?: string;
    check_text?: string;
    resolution?: string;
    note?: string;
    clear?: boolean;
  };
  if (!isSlug(body.slug) || typeof body.check_key !== "string" || !body.check_key) {
    return NextResponse.json({ error: "slug + check_key required" }, { status: 400 });
  }
  const slug = body.slug;
  const key = body.check_key;

  if (body.clear) {
    const { error } = await clearHumanCheckResolution(workspaceId, slug, key);
    if (error) return NextResponse.json({ error }, { status: 500 });
    // Re-open → recompute green state (DB-derived; the writeback is compute-only since
    // spec-status-db-driven — no markdown commit). Best-effort, never blocks the click.
    const green = await reflectSpecGreenChecks(workspaceId, slug).catch(() => null);
    // Auto-fold Gate B sweep (fold-on-spec-test-pass, task #29): human-check resolutions are now ADVISORY and
    // no longer flip fold-eligibility (the machine spec-test pass is the trigger). This call is just a cheap
    // best-effort backstop sweep — it folds any spec whose machine test already passed. Never blocks the click.
    await autoFoldVerifiedSpecs(workspaceId).catch(() => null);
    return NextResponse.json({ ok: true, cleared: true, allGreen: green?.allGreen ?? false });
  }

  // Integrity: the key must be the hash of the supplied bullet text (no writing arbitrary keys).
  if (typeof body.check_text !== "string" || !body.check_text.trim()) {
    return NextResponse.json({ error: "check_text required" }, { status: 400 });
  }
  if (checkKey(body.check_text) !== key) {
    return NextResponse.json({ error: "check_key does not match check_text" }, { status: 400 });
  }
  const resolution = isHumanResolution(body.resolution) ? body.resolution : "verified";
  const { error } = await upsertHumanCheckResolution({
    workspaceId,
    specSlug: slug,
    checkKey: key,
    checkText: body.check_text,
    resolution,
    note: typeof body.note === "string" ? body.note.slice(0, 2000) : null,
    userId: user.id,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });
  // Owner marked ✓ Tested (or another resolution) → recompute green state. The dashboard renders
  // green live from the DB (spec_test_human_checks + spec_test_runs); the writeback is compute-only
  // since spec-status-db-driven (no markdown commit).
  const green = await reflectSpecGreenChecks(workspaceId, slug).catch(() => null);
  // Auto-fold Gate B sweep (fold-on-spec-test-pass, task #29): human-check resolutions are now ADVISORY and
  // no longer gate the fold (the machine spec-test pass is the trigger). Kept as a cheap best-effort backstop
  // sweep so a spec whose machine test already passed folds even if its spec-test-completion sweep was missed.
  await autoFoldVerifiedSpecs(workspaceId).catch(() => null);
  return NextResponse.json({ ok: true, resolution, allGreen: green?.allGreen ?? false });
}
