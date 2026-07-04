// apply-god-mode-sessions-migration — create public.god_mode_sessions +
// public.god_mode_approvals + workspaces.god_mode_pin_hash (Phase 1 of
// docs/brain/specs/god-mode.md). Idempotent (create-if-not-exists / add-column-
// if-not-exists / RLS guarded). Run against the pooler:
//   npx tsx scripts/apply-god-mode-sessions-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260908120000_god_mode_sessions_and_approvals.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    // Verify god_mode_sessions columns.
    const { rows: sessionCols } = await c.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='god_mode_sessions'
        order by ordinal_position`,
    );
    const wantedSession = new Set([
      "id",
      "workspace_id",
      "created_by",
      "status",
      "cockpit_token",
      "token_expires_at",
      "absolute_expires_at",
      "box_session_id",
      "box_session_config_dir",
      "messages",
      "last_activity_at",
      "armed_at",
      "disarmed_at",
      "created_at",
    ]);
    const gotSession = new Set(sessionCols.map((r: { column_name: string }) => r.column_name));
    const missingSession = [...wantedSession].filter((c) => !gotSession.has(c));
    if (missingSession.length) throw new Error(`god_mode_sessions missing columns: ${missingSession.join(", ")}`);
    console.log(`✓ god_mode_sessions has ${gotSession.size} columns`);

    // Verify god_mode_approvals columns.
    const { rows: approvalCols } = await c.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='god_mode_approvals'
        order by ordinal_position`,
    );
    const wantedApproval = new Set([
      "id",
      "session_id",
      "workspace_id",
      "tool_name",
      "tool_input",
      "preview",
      "risk",
      "status",
      "question_text",
      "decided_at",
      "created_at",
    ]);
    const gotApproval = new Set(approvalCols.map((r: { column_name: string }) => r.column_name));
    const missingApproval = [...wantedApproval].filter((c) => !gotApproval.has(c));
    if (missingApproval.length) throw new Error(`god_mode_approvals missing columns: ${missingApproval.join(", ")}`);
    console.log(`✓ god_mode_approvals has ${gotApproval.size} columns`);

    // Verify workspaces.god_mode_pin_hash.
    const { rows: pinCol } = await c.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='workspaces' and column_name='god_mode_pin_hash'`,
    );
    if (!pinCol.length) throw new Error("workspaces.god_mode_pin_hash missing");
    console.log("✓ workspaces.god_mode_pin_hash exists");
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
