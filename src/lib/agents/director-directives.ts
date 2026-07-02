/**
 * Director directives (director-executable-plans-and-priority) — a director's ONE active directive: a plan the
 * CEO hands it via the coaching seat's `plan` intent (CEO-approved), which the standing pass runs FIRST, before
 * the routine lanes, and which can GATE the build queue until a named spec ships. The store + the gate check +
 * the lifecycle helpers live here; the box's standing pass and build lanes read them.
 *
 * North star: a directive re-prioritizes WHAT the director does, never loosens HOW (the leash/loop-guard/
 * escalation rails are unchanged). The CEO approves every directive and can clear it anytime.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap } from "@/lib/brain-roadmap";

type Admin = ReturnType<typeof createAdminClient>;

export interface DirectorDirective {
  id: string;
  workspace_id: string;
  director_function: string;
  summary: string;
  steps: string[];
  gate_builds_until: string | null;
  status: "active" | "done" | "cleared";
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

/** The one active directive for a director, or null. */
export async function getActiveDirective(admin: Admin, workspaceId: string, directorFunction: string): Promise<DirectorDirective | null> {
  const { data } = await admin
    .from("director_directives")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("director_function", directorFunction)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { ...(data as DirectorDirective), steps: Array.isArray((data as DirectorDirective).steps) ? (data as DirectorDirective).steps : [] };
}

/**
 * Create + activate a directive (a new one supersedes the prior). Clears any existing active directive first
 * (so the partial-unique index never trips), then inserts the new one active. Best-effort.
 */
export async function createDirective(
  admin: Admin,
  args: { workspaceId: string; directorFunction: string; summary: string; steps?: string[]; gateBuildsUntil?: string | null; createdBy?: string | null },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!args.summary.trim()) return { ok: false, error: "a directive needs a summary" };
  await admin
    .from("director_directives")
    .update({ status: "cleared", completed_at: new Date().toISOString() })
    .eq("workspace_id", args.workspaceId)
    .eq("director_function", args.directorFunction)
    .eq("status", "active");
  const gate = args.gateBuildsUntil?.trim() ? args.gateBuildsUntil.trim().replace(/[^a-z0-9-]/gi, "") : null;
  const { data, error } = await admin
    .from("director_directives")
    .insert({
      workspace_id: args.workspaceId,
      director_function: args.directorFunction,
      summary: args.summary.slice(0, 2000),
      steps: (args.steps ?? []).map((s) => String(s).slice(0, 500)).slice(0, 30),
      gate_builds_until: gate,
      status: "active",
      created_by: args.createdBy ?? null,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as { id: string }).id };
}

/** Mark a directive done (its gate spec shipped, or the director finished it). */
export async function completeDirective(admin: Admin, id: string): Promise<void> {
  await admin.from("director_directives").update({ status: "done", completed_at: new Date().toISOString() }).eq("id", id);
}

/**
 * CEO clear — terminate the active directive without claiming it shipped. The build gate (if any) lifts on
 * the next read because there's no `active` row left. Idempotent: a row that's already non-active is a no-op.
 * Returns whether a row was actually flipped, so the API can decide between 200 + 404.
 */
export async function clearDirective(admin: Admin, workspaceId: string, id: string): Promise<{ ok: boolean; cleared: boolean }> {
  const { data, error } = await admin
    .from("director_directives")
    .update({ status: "cleared", completed_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .eq("status", "active")
    .select("id");
  if (error) return { ok: false, cleared: false };
  return { ok: true, cleared: (data?.length ?? 0) > 0 };
}

/**
 * The build gate. If the active directive names `gate_builds_until` and that spec is NOT yet shipped, the
 * build-enqueue lanes must pause for every spec EXCEPT the gate spec itself (so the gating fix lands first).
 * Returns the gating slug, or null when there's no gate (no directive, no gate set, or the gate spec shipped —
 * in which case the directive is auto-completed here, lifting the gate). Best-effort; never throws.
 */
export async function buildGate(admin: Admin, workspaceId: string, directorFunction: string): Promise<{ gatedUntil: string } | null> {
  try {
    const directive = await getActiveDirective(admin, workspaceId, directorFunction);
    if (!directive?.gate_builds_until) return null;
    const { specs } = await getRoadmap();
    const gateSpec = specs.find((s) => s.slug === directive.gate_builds_until);
    // Unknown slug or already shipped → lift the gate (+ auto-complete the directive when its gate spec shipped).
    if (!gateSpec || gateSpec.status === "shipped") {
      if (gateSpec?.status === "shipped") await completeDirective(admin, directive.id);
      return null;
    }
    return { gatedUntil: directive.gate_builds_until };
  } catch {
    return null; // a gate-check failure must never stall building — fail open
  }
}

/** Whether a given spec may be built right now given the gate (the gate spec itself is always allowed). */
export function gateAllowsBuild(gate: { gatedUntil: string } | null, specSlug: string): boolean {
  return !gate || gate.gatedUntil === specSlug;
}

/** Build statuses that count as "in-flight" (a build is already carrying the spec). */
const ACTIVE_BUILD_STATUSES = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "blocked_on_usage", "blocked_on_dependency"];
/** Parked statuses safe to cancel (NOT actively building/claimed — never kill a build mid-work). */
const HOLDABLE_BUILD_STATUSES = ["queued", "needs_input", "needs_approval", "blocked_on_usage", "blocked_on_dependency"];

/**
 * #3 — queue a priority build immediately (on the directive's accept pass) instead of waiting for the init
 * cadence. Enqueues a build for `slug` unless it's already in-flight or shipped. Returns true if it queued one.
 * This is what stops a gate spec from sitting un-built while the gate pauses everything else (the stall we hit).
 */
export async function enqueuePriorityBuild(admin: Admin, workspaceId: string, slug: string, createdBy: string | null, reason: string): Promise<boolean> {
  try {
    const { specs } = await getRoadmap();
    const card = specs.find((s) => s.slug === slug);
    if (!card || card.status === "shipped") return false; // gone or already landed
    const { data: active } = await admin.from("agent_jobs").select("id").eq("workspace_id", workspaceId).eq("spec_slug", slug).eq("kind", "build").in("status", ACTIVE_BUILD_STATUSES).limit(1);
    if (active && active.length) return false; // a build is already carrying it
    // intentional override of enqueueBuildIfDue (bo-reactive-gated-build-enqueue Phase 1): a CEO-approved
    // directive elevated this to a PRIORITY build (gate spec / **Priority:** critical) — priority
    // builds are the one lane authorized to jump the review + build-gate queue. The claim-time gate
    // still enforces basic sanity if Vale hasn't stamped it yet.
    const { error } = await admin.from("agent_jobs").insert({ workspace_id: workspaceId, spec_slug: slug, kind: "build", status: "queued", created_by: createdBy, instructions: reason });
    return !error;
  } catch {
    return false;
  }
}

/**
 * #4 — hold/cancel PARKED out-of-order builds (the one executor the directive lacked). Cancels builds for the
 * named specs that are parked (queued / needs_input / needs_approval / blocked) — NEVER an actively-building one
 * (we don't kill mid-work). Terminal `completed` with a clear note; the re-sequencing reconcile re-creates them
 * in order. Disruptive power → only ever invoked from a CEO-approved directive. Returns the slugs it held.
 */
export async function holdBuilds(admin: Admin, workspaceId: string, slugs: string[]): Promise<string[]> {
  const clean = [...new Set(slugs.map((s) => s.replace(/[^a-z0-9-]/gi, "")).filter(Boolean))];
  if (!clean.length) return [];
  try {
    const { data } = await admin
      .from("agent_jobs")
      .update({ status: "completed", log_tail: "held by a CEO directive (out-of-order build) — superseded; the re-sequencing reconcile re-creates it in order" })
      .eq("workspace_id", workspaceId)
      .eq("kind", "build")
      .in("spec_slug", clean)
      .in("status", HOLDABLE_BUILD_STATUSES)
      .select("spec_slug");
    return [...new Set((data ?? []).map((r) => (r as { spec_slug: string }).spec_slug))];
  } catch {
    return [];
  }
}

/**
 * #1 (deterministic core) — the standing-pass SELF-WATCH on the director's own operation. Catches the failure
 * modes we hit so they self-heal or surface instead of silently stalling:
 *   - Gate DEADLOCK: an active directive gates builds until a spec ships, but that gate spec has no in-flight
 *     build → enqueue it (the gate can never lift otherwise). Self-heals the exact stall from 2026-06-24.
 *   - STUCK builds: parked in needs_input/needs_approval/needs_attention for > the stale window → returned so
 *     the standing pass surfaces them (board + activity) for the CEO, since they block silently.
 * Returns notes for the pass to log. Best-effort; never throws into the pass.
 */
export async function selfWatchOperations(admin: Admin, workspaceId: string, directorFunction: string): Promise<{ notes: string[]; healed: string[]; stuck: string[] }> {
  const notes: string[] = [];
  const healed: string[] = [];
  const stuck: string[] = [];
  try {
    // Gate deadlock → self-heal.
    const directive = await getActiveDirective(admin, workspaceId, directorFunction);
    if (directive?.gate_builds_until) {
      const queued = await enqueuePriorityBuild(admin, workspaceId, directive.gate_builds_until, directive.created_by ?? null, `self-watch: gate spec ${directive.gate_builds_until} had no in-flight build — queued it so the gate can lift`);
      if (queued) {
        healed.push(directive.gate_builds_until);
        notes.push(`self-watch: unjammed the gate deadlock — queued ${directive.gate_builds_until}`);
      }
    }
    // Stuck builds (parked > 90 min).
    const cutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const { data: parked } = await admin
      .from("agent_jobs")
      .select("spec_slug, status, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("kind", "build")
      .in("status", ["needs_input", "needs_approval", "needs_attention"])
      .lt("updated_at", cutoff)
      .limit(20);
    for (const j of parked ?? []) stuck.push(`${(j as { spec_slug: string }).spec_slug}(${(j as { status: string }).status})`);
    if (stuck.length) notes.push(`self-watch: ${stuck.length} build(s) stuck > 90m — ${stuck.slice(0, 6).join(", ")}`);
  } catch {
    /* best-effort */
  }
  return { notes, healed, stuck };
}
