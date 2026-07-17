/**
 * POST /api/roadmap/spec-drift — the one-tap owner resolution for a surfaced spec-drift case
 * (spec-drift-agent spec). The Control Tower's "Spec drift" section lists phases whose code is on
 * `main` but whose DB mirror still reads ⏳/🚧 with no merged build on record — cases the reconciler
 * won't auto-flip. Two actions, owner-gated (mirrors /api/roadmap/status):
 *
 *   - flip:    mark the phase ✅ in `spec_card_state` (+ `spec_status_history`), resolve the drift row,
 *              and — if the spec is now fully shipped — enqueue a spec-test (spec-test-on-ship).
 *   - dismiss: leave the state alone; just resolve the drift row (the owner judged it not-drift).
 *
 * spec-status-db-driven Phase 2: this used to PUT the spec markdown to `main` on every flip (one of the
 * six git-committing status writers). Now it writes the DB mirror only — instant, zero deploys.
 * Body: { slug, phaseIndex, action }. See docs/brain/dashboard/control-tower.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSpec, type Phase, type SpecStatus } from "@/lib/brain-roadmap";
import { enqueueSpecTestIfDue } from "@/lib/agent-jobs";
import { resolveSpecDrift } from "@/lib/spec-drift";
import { getSpecCardStates, markSpecCardStatus, rollupPhaseStatus, type SpecCardPhaseState } from "@/lib/spec-card-state";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; phaseIndex?: unknown; action?: unknown };
  const { slug, phaseIndex, action } = body;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }
  if (typeof phaseIndex !== "number" || !Number.isInteger(phaseIndex) || phaseIndex < 0) {
    return NextResponse.json({ error: "bad phaseIndex" }, { status: 400 });
  }
  if (action !== "flip" && action !== "dismiss") {
    return NextResponse.json({ error: "bad action" }, { status: 400 });
  }

  const { user } = await getAuthedUser();
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
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can resolve spec drift" }, { status: 403 });
  }

  // Dismiss: leave the state, just clear the surfaced row.
  if (action === "dismiss") {
    await resolveSpecDrift(workspaceId, slug, phaseIndex);
    return NextResponse.json({ ok: true, action: "dismiss" });
  }

  // Flip: mark the phase ✅ in the DB mirror, then resolve the drift row.
  const spec = await getSpec(slug, workspaceId);
  if (!spec) return NextResponse.json({ error: "spec not found" }, { status: 404 });

  const states = await getSpecCardStates(workspaceId);
  const existing = states[slug];
  const phaseStates: SpecCardPhaseState[] = (existing?.phase_states && existing.phase_states.length)
    ? [...existing.phase_states]
    : spec.card.phases.map((p, i) => ({ index: i, title: p.title, status: p.status as Phase }));

  const target = phaseStates.find((p) => p.index === phaseIndex);
  if (target) {
    if (target.status === "shipped") {
      await resolveSpecDrift(workspaceId, slug, phaseIndex);
      return NextResponse.json({ ok: true, action: "flip", unchanged: true });
    }
    target.status = "shipped";
  } else if (phaseIndex >= 0 && phaseIndex < spec.card.phases.length) {
    phaseStates.push({ index: phaseIndex, title: spec.card.phases[phaseIndex].title, status: "shipped" });
    phaseStates.sort((a, b) => a.index - b.index);
  } else {
    return NextResponse.json({ error: "phaseIndex out of range" }, { status: 400 });
  }

  const nextStatus: SpecStatus = rollupPhaseStatus(phaseStates);
  await markSpecCardStatus(workspaceId, slug, nextStatus, phaseStates, {
    actor: `owner:${user.id}`,
    reason: `spec-drift one-tap flip P${phaseIndex + 1} → ✅`,
  });
  await resolveSpecDrift(workspaceId, slug, phaseIndex);

  if (nextStatus === "shipped") {
    try {
      await enqueueSpecTestIfDue(workspaceId, slug, "shipped");
    } catch {
      /* never fail the flip on enqueue trouble — the daily backlog cron mops it up */
    }
  }

  return NextResponse.json({ ok: true, action: "flip", status: nextStatus });
}
