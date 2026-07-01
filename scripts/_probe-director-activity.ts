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

  console.log("=== APPROVAL DECISIONS (what the director approved) ===\n");
  
  // Oldest approvals without grades
  console.log("Oldest ungraded autonomous approvals (waiting to be graded):");
  const oldest = await c.query(
    `SELECT id, created_at, raised_by_function, agent_job_id 
     FROM approval_decisions 
     WHERE decided_by='director' AND decision='approved' AND autonomous=true
     AND id NOT IN (SELECT DISTINCT approval_decision_id FROM director_decision_grades WHERE dimension='auto-approval' AND approval_decision_id IS NOT NULL)
     ORDER BY created_at ASC
     LIMIT 10`
  );
  
  for (const row of oldest.rows) {
    const age = Date.now() - new Date(row.created_at).getTime();
    const days = (age / 86_400_000).toFixed(2);
    const hours = (age / 3_600_000).toFixed(1);
    console.log(`  ${String(row.id).slice(0, 8)}... — ${days}d (${hours}h) old, raised by ${row.raised_by_function}`);
  }

  // Check why they might not be graded
  console.log("\n=== WHY AREN'T THEY GRADED? ===\n");
  console.log("Checking if the approval target builds have concluded (grading requires terminal status):\n");
  
  for (const row of oldest.rows.slice(0, 3)) {
    const jobCheck = await c.query(
      `SELECT id, kind, spec_slug, status, created_at
       FROM agent_jobs
       WHERE id = $1`,
      [row.agent_job_id]
    );
    
    if (jobCheck.rows.length) {
      const job = jobCheck.rows[0];
      const jobAge = Date.now() - new Date(job.created_at).getTime();
      const jobHours = (jobAge / 3_600_000).toFixed(1);
      const statusEmoji = 
        (job.status === 'completed') ? '✓' :
        (job.status === 'failed' || job.status === 'needs_attention') ? '✗' :
        '⏳';
      console.log(`  Approval ID ${String(row.id).slice(0, 8)}...:`);
      console.log(`    Target job: ${job.kind} ${job.spec_slug || '(no spec)'}`);
      console.log(`    Status: ${statusEmoji} ${job.status} (job created ${jobHours}h ago)`);
    } else {
      console.log(`  Approval ID ${String(row.id).slice(0, 8)}...: target job DELETED`);
    }
  }

  console.log("\n=== WHAT HAPPENED TO LATEST APPROVAL? ===\n");
  
  // Look at the most recent approval
  const latest = await c.query(
    `SELECT id, created_at, raised_by_function, agent_job_id, reasoning
     FROM approval_decisions 
     WHERE decided_by='director' AND decision='approved' AND autonomous=true
     ORDER BY created_at DESC
     LIMIT 1`
  );
  
  if (latest.rows.length) {
    const row = latest.rows[0];
    const age = Date.now() - new Date(row.created_at).getTime();
    const hours = (age / 3_600_000).toFixed(1);
    console.log(`Latest approval: ${String(row.id).slice(0, 8)}... (${hours}h ago)`);
    console.log(`Reasoning: ${row.reasoning?.slice(0, 150) || "(none)"}`);
    
    // Is it graded?
    const gradeCheck = await c.query(
      `SELECT id, grade, graded_by FROM director_decision_grades 
       WHERE approval_decision_id = $1`,
      [row.id]
    );
    
    if (gradeCheck.rows.length) {
      console.log(`✓ GRADED: grade=${gradeCheck.rows[0].grade} by ${gradeCheck.rows[0].graded_by}`);
    } else {
      console.log(`✗ NOT GRADED`);
    }
  }

  await c.end();
}

main().catch(e => { 
  console.error("Probe failed:", e); 
  process.exit(1); 
});
