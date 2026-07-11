/**
 * ceo-approvals — the CEO/founder approval-triage runnable (drives the `ceo-approvals` skill).
 *
 * Surfaces exactly what the developer/approvals dashboard shows as "escalated to the CEO" (Henry seat):
 * pending `dashboard_notifications` of type `agent_approval_request`, not dismissed, whose
 * `routed_to_function === 'ceo'`. Reuses [[../src/lib/agents/approvals-feed]] `buildApprovalsFeed` so
 * the list matches the UI 1:1 (same enrichment: spec · phase · who raised · type · pending action + cmd).
 *
 * Adds a staleness read the dashboard doesn't: for each pending item it fetches the linked agent_jobs
 * row and flags an approval whose job is already terminal (completed / merged / cancelled / superseded)
 * or missing — those are safe to dismiss, the work moved on without the human.
 *
 * Commands:
 *   list                                  (default) print the CEO-routed pending approvals, newest-first
 *   approve <jobId> <actionId> [notes]    approve a gated action (roadmap-actions.approveRoadmapAction)
 *   decline <jobId> <actionId> [notes]    decline a gated action
 *   dismiss <notificationId> [reason]     mark the dashboard_notifications card dismissed (stale cleanup)
 *
 * Owner-scoped: writes are attributed to the workspace owner (role='owner'). Read-only `list` touches
 * nothing. See .claude/skills/ceo-approvals/SKILL.md.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { buildApprovalsFeed } from "../src/lib/agents/approvals-feed";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";

const WS = process.env.SHOPCX_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

/** agent_jobs.status values that mean "this approval's work is already over" — a stale card. */
const TERMINAL_JOB_STATUSES = new Set(["completed", "merged", "cancelled", "superseded", "failed", "declined"]);

async function ownerUserId(admin: ReturnType<typeof createAdminClient>): Promise<string> {
  const { data } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", WS)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  const id = (data as { user_id?: string } | null)?.user_id;
  if (!id) throw new Error("no workspace owner found");
  return id;
}

function ageLabel(iso: string): { days: number; label: string } {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return { days, label: days > 0 ? `${days}d ${hours}h` : `${hours}h` };
}

async function list() {
  const admin = createAdminClient();
  const feed = await buildApprovalsFeed(admin, WS);
  const pending = feed.items.filter((i) => i.source === "pending" && i.escalated);

  // Staleness enrichment: pull the linked job statuses in one batch.
  const jobIds = Array.from(new Set(pending.map((i) => i.jobId).filter((v): v is string => Boolean(v))));
  const jobStatus = new Map<string, string>();
  if (jobIds.length) {
    const { data } = await admin.from("agent_jobs").select("id, status").in("id", jobIds);
    for (const j of (data ?? []) as { id: string; status: string }[]) jobStatus.set(j.id, j.status);
  }

  console.log(`\n=== CEO-routed approvals: ${pending.length} pending ===\n`);
  pending.forEach((i, n) => {
    const age = ageLabel(i.createdAt);
    const jStatus = i.jobId ? (jobStatus.get(i.jobId) ?? "MISSING") : "—";
    const stale =
      (i.jobId && (jobStatus.get(i.jobId) === undefined || TERMINAL_JOB_STATUSES.has(jobStatus.get(i.jobId) ?? ""))) ||
      age.days >= 7;
    const where = i.spec ? `spec:${i.spec.slug}${i.phase ? ` · ${i.phase}` : ""}` : i.goal ? `goal:${i.goal.slug}` : "—";
    console.log(`[${n + 1}] ${i.typeLabel}${stale ? "  ⚠️ STALE" : ""}`);
    console.log(`    ${where}`);
    console.log(`    raised=${i.raisedBy?.name ?? "?"} → ${i.routedTo?.name ?? "CEO"}   age=${age.label}   job=${jStatus}`);
    if (i.summary) console.log(`    why: ${i.summary.slice(0, 220)}`);
    for (const a of i.actions) {
      console.log(`    action=${a.id}  ${a.summary?.slice(0, 100) ?? ""}`);
      if (a.cmd) console.log(`      $ ${a.cmd.slice(0, 180)}`);
    }
    console.log(`    → approve: ceo-approvals approve ${i.jobId ?? "?"} ${i.actions[0]?.id ?? "?"}`);
    console.log(`    → dismiss: ceo-approvals dismiss ${i.id}`);
    console.log("");
  });
  const staleCount = pending.filter((i) => {
    const s = i.jobId ? jobStatus.get(i.jobId) : undefined;
    return (i.jobId && (s === undefined || TERMINAL_JOB_STATUSES.has(s ?? ""))) || ageLabel(i.createdAt).days >= 7;
  }).length;
  console.log(`(${staleCount} flagged STALE — job already terminal/missing or >7d old)\n`);
}

async function decide(decision: "approve" | "decline", jobId: string, actionId: string, notes?: string) {
  const admin = createAdminClient();
  const uid = await ownerUserId(admin);
  const res = await approveRoadmapAction(WS, uid, { jobId, actionId, decision, notes: notes ?? undefined });
  console.log(`${decision}: ${JSON.stringify(res)}`);
}

async function dismiss(notificationId: string, reason?: string) {
  const admin = createAdminClient();
  const { error } = await admin
    .from("dashboard_notifications")
    .update({ dismissed: true, dismissed_reason: reason ?? "stale — CEO triage" })
    .eq("workspace_id", WS)
    .eq("id", notificationId);
  if (error) {
    // dismissed_reason may not exist on the table — retry with just the flag.
    const { error: e2 } = await admin.from("dashboard_notifications").update({ dismissed: true }).eq("workspace_id", WS).eq("id", notificationId);
    if (e2) throw e2;
  }
  console.log(`dismissed notification ${notificationId}`);
}

// ── Plan review + one-shot plan approval ────────────────────────────────────
//
// A planner (Pia, kind='plan') proposes N specs as `agent_jobs.pending_actions`. The plan job only
// resumes + materializes the specs once EVERY action has a decision (roadmap-actions.ts §"Resume only
// once every action has a decision"). Approving 10 actions one-by-one is the pain these two commands
// remove: `plan <ref>` renders the proposal (specs + dependency graph) so you can judge it; then
// `approve-plan <ref>` (or `decline-plan`) dispositions ALL pending actions in one shot.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type PlanAction = { id: string; status?: string; kind?: string; type?: string; [k: string]: unknown };
type PlanSpec = { slug?: string; owner?: string; title?: string; summary?: string; blocked_by?: string[]; blockedBy?: string[]; phases?: { position?: number; title?: string }[] };

/** Resolve a plan job by its UUID or by the goal slug it plans (kind='plan', spec_slug=goal). */
async function resolvePlanJob(admin: ReturnType<typeof createAdminClient>, ref: string) {
  const q = admin.from("agent_jobs").select("id, kind, status, spec_slug, pending_actions").eq("workspace_id", WS);
  const { data } = UUID_RE.test(ref)
    ? await q.eq("id", ref).maybeSingle()
    : await q.eq("kind", "plan").eq("spec_slug", ref).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) throw new Error(`no plan job found for "${ref}" (pass the plan jobId or the goal slug)`);
  return data as { id: string; kind: string; status: string; spec_slug: string; pending_actions: PlanAction[] | null };
}

const specOf = (a: PlanAction): PlanSpec => ((a.spec as PlanSpec) || (a.proposed_spec as PlanSpec) || (a.payload as PlanSpec) || (a as unknown as PlanSpec));
const blockedOf = (s: PlanSpec): string[] => s.blocked_by || s.blockedBy || [];

async function showPlan(ref: string) {
  const admin = createAdminClient();
  const job = await resolvePlanJob(admin, ref);
  const actions = job.pending_actions || [];
  console.log(`\n=== plan: ${job.spec_slug} ===  job=${job.id}  status=${job.status}  actions=${actions.length}`);
  const pending = actions.filter((a) => (a.status ?? "pending") === "pending").length;
  console.log(`decided=${actions.length - pending}  pending=${pending}\n`);
  for (const a of actions) {
    const s = specOf(a);
    const dep = blockedOf(s);
    console.log(`• [${a.status ?? "pending"}] ${s.slug ?? a.id}  (owner=${s.owner ?? "?"})`);
    console.log(`    ${s.title ?? ""}`);
    if (dep.length) console.log(`    ⤷ after: ${dep.join(", ")}`);
    if (s.summary) console.log(`    ${s.summary.slice(0, 200)}`);
    for (const p of s.phases || []) console.log(`      P${p.position ?? ""}: ${p.title ?? ""}`);
  }
  console.log(`\napprove all: ceo-approvals approve-plan ${job.spec_slug}   ·   decline all: ceo-approvals decline-plan ${job.spec_slug}\n`);
}

async function decidePlan(ref: string, decision: "approve" | "decline", notes?: string) {
  const admin = createAdminClient();
  const uid = await ownerUserId(admin);
  const job = await resolvePlanJob(admin, ref);
  const actions = job.pending_actions || [];
  const pending = actions.filter((a) => (a.status ?? "pending") === "pending");
  if (!pending.length) {
    console.log(`plan "${job.spec_slug}" has no pending actions (job status=${job.status}) — nothing to ${decision}.`);
    return;
  }
  console.log(`${decision}-plan ${job.spec_slug} (job=${job.id}) — ${pending.length} pending action(s):`);
  let last: unknown = null;
  for (const a of pending) {
    const res = await approveRoadmapAction(WS, uid, { jobId: job.id, actionId: a.id, decision, notes });
    const ok = (res as { ok?: boolean }).ok;
    console.log(`  ${ok ? "✓" : "✗"} ${specOf(a).slug ?? a.id}${ok ? "" : "  ← " + JSON.stringify(res)}`);
    last = res;
  }
  const job2 = await resolvePlanJob(admin, job.id);
  console.log(`\nplan job now status=${job2.status}${job2.status === "queued_resume" ? " → materializing specs on next worker tick" : ""}`);
  if (!(last as { ok?: boolean } | null)?.ok) process.exitCode = 1;
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "list":
      await list();
      break;
    case "plan":
      await showPlan(rest[0]);
      break;
    case "approve-plan":
      await decidePlan(rest[0], "approve", rest.slice(1).join(" ") || undefined);
      break;
    case "decline-plan":
      await decidePlan(rest[0], "decline", rest.slice(1).join(" ") || undefined);
      break;
    case "approve":
      await decide("approve", rest[0], rest[1], rest.slice(2).join(" ") || undefined);
      break;
    case "decline":
      await decide("decline", rest[0], rest[1], rest.slice(2).join(" ") || undefined);
      break;
    case "dismiss":
      await dismiss(rest[0], rest.slice(1).join(" ") || undefined);
      break;
    default:
      console.error(`unknown command: ${cmd}. Use: list | plan <ref> | approve-plan <ref> | decline-plan <ref> | approve <jobId> <actionId> [notes] | decline … | dismiss <notificationId> [reason]`);
      process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
