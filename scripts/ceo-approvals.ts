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

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "list":
      await list();
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
      console.error(`unknown command: ${cmd}. Use: list | approve <jobId> <actionId> [notes] | decline … | dismiss <notificationId> [reason]`);
      process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
