// apply-workspaces-slack-growth-director-channel-id-migration — Phase 1 of
// media-buyer-director-slack-digest. Adds workspaces.slack_growth_director_channel_id
// (mirrors slack_ada_channel_id) and seeds the Superfoods workspace with the existing
// private #director-growth-max channel id (C0BFW5YUVC1 — bot is already a member).
//
// Additive + nullable + idempotent (IF NOT EXISTS + conditional UPDATE). See
// docs/brain/specs/media-buyer-director-slack-digest.md.
//   npx tsx scripts/apply-workspaces-slack-growth-director-channel-id-migration.ts
import { pgClient } from "./_bootstrap";

const SUPERFOODS_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const GROWTH_DIRECTOR_CHANNEL_ID = "C0BFW5YUVC1";

const STATEMENTS = [
  `alter table public.workspaces
     add column if not exists slack_growth_director_channel_id text`,
  `update public.workspaces
       set slack_growth_director_channel_id = '${GROWTH_DIRECTOR_CHANNEL_ID}'
     where id = '${SUPERFOODS_WORKSPACE_ID}'
       and (slack_growth_director_channel_id is null
            or slack_growth_director_channel_id <> '${GROWTH_DIRECTOR_CHANNEL_ID}')`,
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
      `select id, name, slack_growth_director_channel_id
         from public.workspaces
        where id = '${SUPERFOODS_WORKSPACE_ID}'`,
    );
    console.log("✓ Superfoods workspace:", rows);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
