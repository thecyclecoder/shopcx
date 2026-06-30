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
  
  console.log("=== DIRECTOR GRADING STALENESS PROBE ===\n");

  // 1. Latest director grades
  const latestGrades = await c.query(
    `SELECT created_at, dimension, approval_decision_id, goal_slug, milestone, grade 
     FROM director_decision_grades 
     ORDER BY created_at DESC 
     LIMIT 5`
  );
  
  if (latestGrades.rows.length) {
    console.log("✓ Latest 5 director grades:");
    for (const g of latestGrades.rows) {
      const age = Date.now() - new Date(g.created_at).getTime();
      const days = (age / 86_400_000).toFixed(1);
      const dimension = g.dimension === "auto-approval" 
        ? `auto-approval ${String(g.approval_decision_id).slice(0, 8)}` 
        : `goal-escort ${g.goal_slug} / ${g.milestone}`;
      console.log(`  ${String(g.created_at).slice(0, 10)} (${days}d ago) — ${dimension} grade=${g.grade}`);
    }
  } else {
    console.log("✗ No director grades found");
  }

  // 2. Count autonomous approvals & ungraded
  const counts = await c.query(
    `SELECT 
      (SELECT COUNT(*) FROM approval_decisions WHERE decided_by='director' AND decision='approved' AND autonomous=true) as total_autonomous,
      (SELECT COUNT(DISTINCT approval_decision_id) FROM director_decision_grades WHERE dimension='auto-approval' AND approval_decision_id IS NOT NULL) as graded`
  );
  
  if (counts.rows.length) {
    const row = counts.rows[0];
    const totalAutonomous = parseInt(row.total_autonomous, 10);
    const graded = parseInt(row.graded, 10);
    const ungraded = totalAutonomous - graded;
    console.log(`\n✓ Autonomous director approvals: ${totalAutonomous} total, ${graded} graded, ${ungraded} UNGRADED`);
    
    if (ungraded > 0) {
      const oldest = await c.query(
        `SELECT created_at 
         FROM approval_decisions 
         WHERE decided_by='director' AND decision='approved' AND autonomous=true 
         AND id NOT IN (SELECT DISTINCT approval_decision_id FROM director_decision_grades WHERE dimension='auto-approval' AND approval_decision_id IS NOT NULL)
         ORDER BY created_at ASC 
         LIMIT 1`
      );
      if (oldest.rows.length) {
        const age = Date.now() - new Date(oldest.rows[0].created_at).getTime();
        const days = (age / 86_400_000).toFixed(1);
        const hours = (age / 3_600_000).toFixed(1);
        console.log(`  ⚠️  Oldest ungraded: ${String(oldest.rows[0].created_at).slice(0, 10)} (${days}d = ${hours}h ago)`);
      }
    }
  }

  // 3. Goal escort grades
  const escortGrades = await c.query(
    `SELECT COUNT(DISTINCT (goal_slug, milestone)) as escorted_milestones
     FROM director_decision_grades 
     WHERE dimension='goal-escort'`
  );
  
  const escortActivity = await c.query(
    `SELECT COUNT(DISTINCT metadata->>'goal_slug') as escorted_goals
     FROM director_activity 
     WHERE action_kind='escorted_goal' AND metadata->>'goal_slug' IS NOT NULL`
  );
  
  if (escortGrades.rows.length && escortActivity.rows.length) {
    const escorted = parseInt(escortActivity.rows[0].escorted_goals, 10);
    const graded = parseInt(escortGrades.rows[0].escorted_milestones, 10);
    console.log(`\n✓ Goal escorts: ${escorted} goals escorted, ${graded} milestones graded, ${escorted - graded} UNGRADED`);
  }

  // 4. Summary
  const allGrades = await c.query(
    `SELECT dimension, COUNT(*) as cnt FROM director_decision_grades GROUP BY dimension`
  );
  
  console.log(`\n✓ Total director grades persisted:`);
  for (const row of allGrades.rows) {
    console.log(`  ${row.dimension}: ${row.cnt}`);
  }

  // 5. Inference about staleness
  console.log("\n=== STALENESS ANALYSIS ===");
  const latestGrade = latestGrades.rows[0];
  if (latestGrade) {
    const ageMs = Date.now() - new Date(latestGrade.created_at).getTime();
    const hours = ageMs / 3_600_000;
    if (hours < 1) {
      console.log("✓ Grading is ACTIVE — latest grade < 1 hour ago");
    } else if (hours < 24) {
      console.log(`⚠️  Grading slowed — latest grade ${hours.toFixed(1)}h ago`);
    } else {
      console.log(`❌ GRADING STALLED — latest grade ${(ageMs / 86_400_000).toFixed(1)}d ago`);
    }
  }
  
  // Check if cron is running
  const cronHeartbeat = await c.query(
    `SELECT created_at FROM loop_heartbeats 
     WHERE loop_id='platform-director-cron' 
     ORDER BY created_at DESC 
     LIMIT 1`
  );
  
  if (cronHeartbeat.rows.length) {
    const lastBeat = cronHeartbeat.rows[0].created_at;
    const ageMs = Date.now() - new Date(lastBeat).getTime();
    const mins = ageMs / 60_000;
    if (mins < 10) {
      console.log(`✓ platform-director-cron ALIVE — last heartbeat ${mins.toFixed(1)}m ago`);
    } else {
      console.log(`⚠️  platform-director-cron heartbeat ${mins.toFixed(1)}m ago (expected ~5m)`);
    }
  } else {
    console.log("❓ platform-director-cron heartbeat not found");
  }

  await c.end();
  console.log("\n=== CONTEXT ===");
  console.log("Grading is invoked from: src/lib/inngest/platform-director-cron.ts");
  console.log("Step name: 'grade-concluded-director-calls' (lines 82–95)");
  console.log("Function: gradeConcludedDirectorCalls() [src/lib/agents/director-grader.ts lines 458–506]");
  console.log("Cadence: cron */5 * * * * (every 5 minutes)");
  console.log("Runtime: Deployed Inngest (not on the box)");
}

main().catch(e => { 
  console.error("Probe failed:", e); 
  process.exit(1); 
});
