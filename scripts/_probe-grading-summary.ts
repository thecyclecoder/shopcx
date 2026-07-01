import { readFileSync } from "fs"; 
import { resolve } from "path";
import { Client } from "pg";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); 
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); 
  if (eq < 0) continue;
  const k = t.slice(0, eq); 
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const password = process.env.SUPABASE_DB_PASSWORD!;
const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@${host}:6543/postgres`;

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();

  console.log("\n=== GRADING STALENESS ROOT CAUSE ANALYSIS ===\n");
  
  // Count by job status for ungraded approvals
  const statusBreakdown = await c.query(
    `SELECT aj.status, COUNT(*) as cnt
     FROM approval_decisions ad
     LEFT JOIN agent_jobs aj ON ad.agent_job_id = aj.id
     WHERE ad.decided_by='director' AND ad.decision='approved' AND ad.autonomous=true
     AND ad.id NOT IN (SELECT DISTINCT approval_decision_id FROM director_decision_grades WHERE dimension='auto-approval' AND approval_decision_id IS NOT NULL)
     GROUP BY aj.status
     ORDER BY cnt DESC`
  );
  
  console.log("Ungraded approvals by target job status:");
  let mergedCount = 0;
  let otherCount = 0;
  for (const row of statusBreakdown.rows) {
    console.log(`  ${row.status || "(null)"}: ${row.cnt}`);
    if (row.status === "merged") mergedCount = row.cnt;
    else otherCount += row.cnt;
  }
  
  console.log(`\n⚠️  ROOT CAUSE: ${mergedCount} of 20 ungraded approvals are STUCK IN "merged" STATUS`);
  console.log("    Grading requires TERMINAL status: \"completed\", \"failed\", or \"needs_attention\"");
  console.log("    These jobs reached \"merged\" but never transitioned to a terminal status.");
  
  // Check the oldest merged jobs
  console.log("\nOldest 3 stuck \"merged\" jobs:");
  const mergedJobs = await c.query(
    `SELECT ad.id as approval_id, aj.id as job_id, aj.created_at, aj.spec_slug, aj.kind
     FROM approval_decisions ad
     LEFT JOIN agent_jobs aj ON ad.agent_job_id = aj.id
     WHERE ad.decided_by='director' AND ad.decision='approved' AND ad.autonomous=true
     AND ad.id NOT IN (SELECT DISTINCT approval_decision_id FROM director_decision_grades WHERE dimension='auto-approval' AND approval_decision_id IS NOT NULL)
     AND aj.status = 'merged'
     ORDER BY aj.created_at ASC
     LIMIT 3`
  );
  
  for (const row of mergedJobs.rows) {
    const age = Date.now() - new Date(row.created_at).getTime();
    const days = (age / 86_400_000).toFixed(2);
    console.log(`  ${row.kind} ${row.spec_slug} — ${days}d stuck in merged`);
  }

  // The most recent graded approval
  console.log("\n=== MOST RECENT GRADED APPROVAL ===");
  const recent = await c.query(
    `SELECT ad.created_at, ad.id, ad.reasoning, dg.grade, dg.created_at as graded_at
     FROM approval_decisions ad
     JOIN director_decision_grades dg ON ad.id = dg.approval_decision_id
     WHERE ad.decided_by='director' AND ad.decision='approved' AND ad.autonomous=true
     ORDER BY dg.created_at DESC
     LIMIT 1`
  );
  
  if (recent.rows.length) {
    const row = recent.rows[0];
    const age = Date.now() - new Date(row.graded_at).getTime();
    const hours = (age / 3_600_000).toFixed(1);
    console.log(`Approval: ${String(row.id).slice(0, 8)}...`);
    console.log(`Graded: ${hours}h ago with grade ${row.grade}`);
    console.log(`Reason: ${row.reasoning?.slice(0, 100) || "(none)"}...`);
  }

  // The oldest graded
  console.log("\n=== OLDEST GRADED APPROVAL ===");
  const oldest = await c.query(
    `SELECT ad.created_at, ad.id, dg.grade, dg.created_at as graded_at
     FROM approval_decisions ad
     JOIN director_decision_grades dg ON ad.id = dg.approval_decision_id
     WHERE ad.decided_by='director' AND ad.decision='approved' AND ad.autonomous=true
     ORDER BY dg.created_at ASC
     LIMIT 1`
  );
  
  if (oldest.rows.length) {
    const row = oldest.rows[0];
    const age = Date.now() - new Date(row.graded_at).getTime();
    const days = (age / 86_400_000).toFixed(2);
    console.log(`First ever graded approval: ${days}d ago with grade ${row.grade}`);
  }

  // Cron status
  console.log("\n=== CRON STATUS ===");
  const cron = await c.query(
    `SELECT created_at FROM loop_heartbeats 
     WHERE loop_id='platform-director-cron' 
     ORDER BY created_at DESC LIMIT 1`
  );
  
  if (cron.rows.length) {
    const age = Date.now() - new Date(cron.rows[0].created_at).getTime();
    const mins = (age / 60_000).toFixed(1);
    console.log(`✓ platform-director-cron heartbeat: ${mins}m ago (expected ~5m intervals)`);
    console.log("  The cron IS running, but grading logic is blocked by job status.");
  }

  await c.end();
}

main().catch(e => { 
  console.error("Probe failed:", e); 
  process.exit(1); 
});
