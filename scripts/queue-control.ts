/**
 * queue-control — operate the agent_jobs build queue from the CLI (the box worker's queue).
 *
 * The dashboard (/dashboard/roadmap) is the normal way to queue/approve/merge builds; this is the
 * break-glass CLI for when you need to pause the fleet, recover from a bad state, or batch-manage.
 *
 *   npx tsx scripts/queue-control.ts list                 # active (non-terminal) jobs
 *   npx tsx scripts/queue-control.ts queue <spec-slug>    # queue a build (same as the board's Build)
 *   npx tsx scripts/queue-control.ts hold                 # pause: queued/queued_resume → held (snapshot saved)
 *   npx tsx scripts/queue-control.ts release              # resume: held → queued
 *   npx tsx scripts/queue-control.ts requeue-stale        # building/claimed (killed by a restart) → queued
 *   npx tsx scripts/queue-control.ts reset-all            # CLEAN SLATE: every non-terminal job → fresh queued (STOP the worker first)
 *   npx tsx scripts/queue-control.ts complete <spec-slug> # force a stuck job → completed (PR already done)
 *
 * Run on the box (worker host) or locally with prod creds in .env.local. See
 * docs/brain/recipes/manage-the-build-queue.md.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}
const SNAP = resolve(__dirname, "../.queue-snapshot.json");

(async () => {
  const cmd = process.argv[2] || "list";
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const a = createAdminClient();
  const now = () => new Date().toISOString();
  const slugs = (rows: { spec_slug: string }[] | null) => (rows || []).map((r) => r.spec_slug).join(", ");

  if (cmd === "queue") {
    const slug = process.argv[3];
    if (!slug) throw new Error("usage: queue-control.ts queue <spec-slug>");
    const { data: ws } = await a.from("workspaces").select("id,name");
    const sf = (ws || []).find((w: { name: string }) => /superfood/i.test(w.name)) || (ws || [])[0];
    const { data, error } = await a.from("agent_jobs").insert({ workspace_id: sf!.id, spec_slug: slug, status: "queued" }).select("spec_slug,status").single();
    console.log("QUEUED:", JSON.stringify(data), error?.message ?? "");
  } else if (cmd === "hold") {
    const { data } = await a.from("agent_jobs").select("id,spec_slug,status,kind,instructions,pr_number").in("status", ["queued", "queued_resume"]);
    writeFileSync(SNAP, JSON.stringify(data, null, 2));
    for (const j of data || []) await a.from("agent_jobs").update({ status: "held", updated_at: now() }).eq("id", j.id);
    console.log(`HELD ${data?.length || 0} (snapshot → ${SNAP}):`, slugs(data));
  } else if (cmd === "release") {
    const { data } = await a.from("agent_jobs").update({ status: "queued", updated_at: now() }).eq("status", "held").select("spec_slug");
    console.log(`RELEASED ${data?.length || 0}:`, slugs(data));
  } else if (cmd === "requeue-stale") {
    const { data } = await a.from("agent_jobs").update({ status: "queued", claude_session_id: null, spec_branch: null, pending_actions: [], updated_at: now() }).in("status", ["building", "claimed"]).select("spec_slug");
    console.log(`REQUEUED ${data?.length || 0} stale:`, slugs(data));
  } else if (cmd === "reset-all") {
    // Clean slate: every non-terminal job → fresh queued. STOP the worker first or you race active lanes.
    const { data } = await a.from("agent_jobs").update({ status: "queued", claude_session_id: null, spec_branch: null, pending_actions: [], updated_at: now() }).not("status", "in", "(completed,failed,merged)").select("spec_slug");
    console.log(`RESET-ALL ${data?.length || 0}:`, slugs(data));
  } else if (cmd === "complete") {
    const slug = process.argv[3];
    if (!slug) throw new Error("usage: queue-control.ts complete <spec-slug>");
    const { data } = await a.from("agent_jobs").update({ status: "completed", updated_at: now() }).eq("spec_slug", slug).in("status", ["held", "queued_resume", "needs_approval", "building"]).select("spec_slug,status,pr_number");
    console.log("COMPLETED:", JSON.stringify(data));
  } else {
    const { data } = await a.from("agent_jobs").select("spec_slug,status,pr_number,updated_at").not("status", "in", "(completed,failed,merged)").order("updated_at", { ascending: false });
    for (const j of data || []) console.log(`${String(j.status).padEnd(14)} ${j.spec_slug} PR#${j.pr_number ?? "-"}`);
    if (!data?.length) console.log("(queue empty)");
  }
})();
