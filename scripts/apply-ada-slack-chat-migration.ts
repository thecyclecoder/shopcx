// apply-ada-slack-chat-migration — add the columns that let a Slack message in #cto-ada become a
// director_coach_thread turn and route Ada's reply back (docs/brain/specs/ada-slack-chat.md).
//
// Additive + nullable; idempotent via IF NOT EXISTS. Runs the migration file's statements.
//   npx tsx scripts/apply-ada-slack-chat-migration.ts
import { pgClient } from "./_bootstrap";

const STATEMENTS = [
  `alter table public.workspaces
     add column if not exists slack_ada_channel_id text`,
  `alter table public.director_coach_threads
     add column if not exists source text not null default 'web',
     add column if not exists slack_channel_id text,
     add column if not exists slack_thread_ts text`,
  `create index if not exists idx_director_coach_threads_slack_thread
     on public.director_coach_threads (workspace_id, slack_thread_ts)
     where slack_thread_ts is not null`,
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const sql of STATEMENTS) {
      await c.query(sql);
      console.log(`✓ ${sql.trim().split("\n")[0]} …`);
    }
    const { rows } = await c.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'workspaces' and column_name = 'slack_ada_channel_id')
           or (table_name = 'director_coach_threads' and column_name in ('source','slack_channel_id','slack_thread_ts')))
       order by table_name, column_name`,
    );
    console.log("✓ present:", rows.map((r) => `${r.table_name}.${r.column_name}`));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
