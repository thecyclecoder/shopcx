/**
 * POST /api/roadmap/status — set a spec's overall status / one phase's status. Owner-gated.
 *
 * repurpose-spec-drift-reconciler Phase 2: spec status is now DERIVED from `spec_phases`, so this
 * route writes the CANONICAL leaf (a `spec_phases` row) instead of the `spec_card_state` mirror —
 * the board derives the rollup automatically. `in_review` is the one exception (an explicit
 * lifecycle override, not derived) and still routes through `markSpecCardBackToReview`.
 *
 * Body: { slug, status } or { slug, phaseIndex, status }. See docs/brain/dashboard/roadmap.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSpec, type Phase, type SpecStatus } from "@/lib/brain-roadmap";
import { enqueueSpecTestIfDue } from "@/lib/agent-jobs";
import { getSpecCardStates, markSpecCardShortCircuit, markSpecCardBackToReview, rollupPhaseStatus, type SpecCardPhaseState } from "@/lib/spec-card-state";
import { markPhaseInProgress, markRemainingPhasesShipped, restampPhases } from "@/lib/specs-table";
import { recordDirectorActivity } from "@/lib/director-activity";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; status?: unknown; phaseIndex?: unknown };
  const { slug, status } = body;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }
  // spec-review-agent Phase 4 — accept `in_review` as a CEO board control (the "send this spec back to
  // re-disposition" action for a malformed/off spec). Routed through markSpecCardBackToReview, which
  // consumes the prior vale_pass / ada_disposition / intended_status signals so the next Vale + Ada pass
  // start clean.
  if (status !== "planned" && status !== "in_progress" && status !== "shipped" && status !== "rejected" && status !== "in_review") {
    return NextResponse.json({ error: "bad status" }, { status: 400 });
  }
  if (status === "in_review" && typeof body.phaseIndex === "number") {
    // A phase doesn't HAVE an in_review status — it's a spec-level lane only.
    return NextResponse.json({ error: "in_review is a card-level status, not a phase status" }, { status: 400 });
  }
  const newPhaseStatus = status as Phase;

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
    return NextResponse.json({ error: "Only the workspace owner can change roadmap status" }, { status: 403 });
  }

  // Read the spec for phase titles (markdown is still the source for content + phase titles).
  const spec = await getSpec(slug, workspaceId);
  if (!spec) return NextResponse.json({ error: "spec not found" }, { status: 404 });

  // Seed the per-phase snapshot from the current DB row when present, else from the spec card (which
  // already has the DB overlay applied). Keeps phase_states stable across writers.
  const states = await getSpecCardStates(workspaceId);
  const existing = states[slug];

  // spec-review-agent Phase 4 — the CEO board control fast-path. Status='in_review' routes through the
  // shared back-to-review writer (clears vale_pass / ada_disposition / intended_status so the next Vale +
  // Ada pass start clean) + a director_activity row carrying the CEO's actor.
  if (status === "in_review") {
    await markSpecCardBackToReview(workspaceId, slug, { actor: `owner:${user.id}`, reason: "CEO sent spec back to in_review via the board control" });
    try {
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "ceo",
        actionKind: "spec_sent_back_to_review",
        specSlug: slug,
        reason: "CEO sent spec back to in_review via the board control (malformed/off — needs re-disposition)",
        metadata: { source: "board_control" },
      });
    } catch {
      /* best-effort audit — never fail the status write on the activity row */
    }
    return NextResponse.json({ ok: true, status: "in_review" });
  }

  const phaseStates: SpecCardPhaseState[] = (existing?.phase_states && existing.phase_states.length)
    ? [...existing.phase_states]
    : spec.card.phases.map((p, i) => ({ index: i, title: p.title, status: p.status as Phase }));

  const idx = typeof body.phaseIndex === "number" ? body.phaseIndex : null;
  let nextStatus: SpecStatus;

  // repurpose-spec-drift-reconciler Phase 2: write the canonical leaf in `spec_phases` (1-based position
  // mirrors specs-table convention), not the `spec_card_state` mirror — the board derives status from
  // the phases. Per-phase flips touch the named position; spec-level flips translate to the appropriate
  // phase write (shipped → mark every non-shipped phase shipped; in_progress → flip the earliest planned
  // phase; planned/rejected → write that status across every non-terminal phase).
  if (idx !== null) {
    if (!(idx >= 0 && idx < spec.card.phases.length)) {
      return NextResponse.json({ error: "bad phaseIndex" }, { status: 400 });
    }
    const target = phaseStates.find((p) => p.index === idx);
    if (target) target.status = newPhaseStatus;
    else {
      phaseStates.push({ index: idx, title: spec.card.phases[idx].title, status: newPhaseStatus });
      phaseStates.sort((a, b) => a.index - b.index);
    }
    // Owner flip carries no merge provenance — null both. A regression away from `shipped` clears the
    // prior `pr`/`merge_sha` (they belong to the merge that's no longer truthful).
    await restampPhases(workspaceId, slug, [{ position: idx + 1, status: newPhaseStatus, pr: null, merge_sha: null }]);
    nextStatus = phaseStates.length ? rollupPhaseStatus(phaseStates) : newPhaseStatus;
  } else {
    // Spec-level flip: translate to phase writes so the derived rollup matches.
    if (newPhaseStatus === "shipped") {
      await markRemainingPhasesShipped(workspaceId, slug);
      for (const p of phaseStates) p.status = "shipped";
    } else if (newPhaseStatus === "in_progress") {
      await markPhaseInProgress(workspaceId, slug);
      const i = phaseStates.findIndex((p) => p.status === "planned");
      if (i >= 0) phaseStates[i].status = "in_progress";
    } else if (newPhaseStatus === "planned" || newPhaseStatus === "rejected") {
      // Regress every non-terminal phase to the requested status. `restampPhases` clears pr/merge_sha
      // for each touched position (the prior provenance no longer reflects truth).
      const writes = phaseStates
        .filter((p) => p.status !== newPhaseStatus)
        .map((p) => ({ position: p.index + 1, status: newPhaseStatus, pr: null, merge_sha: null }));
      if (writes.length) await restampPhases(workspaceId, slug, writes);
      for (const p of phaseStates) p.status = newPhaseStatus;
    }
    nextStatus = phaseStates.length ? rollupPhaseStatus(phaseStates) : newPhaseStatus;
  }

  // director-dismiss-park-and-short-circuit-spec Phase 2: a short-circuit marker only makes sense for a
  // shipped card. When the owner flips a short-circuited spec back off `shipped`, clear the marker so the
  // card stops rendering "short-circuited — …" — restoring normal handling.
  const wasShortCircuited = existing?.flags?.short_circuit === true;
  if (wasShortCircuited && nextStatus !== "shipped") {
    await markSpecCardShortCircuit(workspaceId, slug, false);
  }

  if (nextStatus === "shipped") {
    try {
      await enqueueSpecTestIfDue(workspaceId, slug, "shipped");
    } catch {
      /* never fail the status write on enqueue trouble — the daily backlog cron mops it up */
    }
  }

  return NextResponse.json({ ok: true, status: nextStatus });
}
