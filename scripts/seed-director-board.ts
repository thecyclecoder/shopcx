// seed-director-board — prove the #directors board surface (directors-board-gamified Phase 1).
//
// Inserts a small, conversational, persona-styled seed thread into public.director_messages for the
// Superfoods workspace so the Messages tab renders a real Slack-style channel BEFORE the live Platform
// director (M4) becomes the first real author: a system welcome, an Ada/Platform update, and a CEO reply
// threaded under it (proving persona render + threading + @-mentions). Idempotent — guarded on a seed
// marker in metadata, so re-running is a no-op. Run against prod:
//   npx tsx scripts/seed-director-board.ts
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SEED_MARKER = "board-intro-v1";

async function main() {
  const admin = createAdminClient();

  // Idempotency: bail if this seed already ran for the workspace.
  const { data: existing } = await admin
    .from("director_messages")
    .select("id")
    .eq("workspace_id", WS)
    .eq("metadata->>seed", SEED_MARKER)
    .limit(1);
  if (existing && existing.length > 0) {
    console.log("✓ board seed already present — nothing to do");
    return;
  }

  const meta = { seed: SEED_MARKER };

  // 1. System welcome (top-level).
  const { data: sys, error: e1 } = await admin
    .from("director_messages")
    .insert({
      workspace_id: WS,
      author: "system",
      body: "Welcome to #directors — the team channel where your directors post what they ship. Each one is a character; reply or ask \"why?\" and they'll answer in-thread (coming soon).",
      kind: "update",
      metadata: meta,
    })
    .select("id")
    .single();
  if (e1) throw e1;

  // 2. Ada / Platform update (persona-styled, conversational) — top-level.
  const { data: ada, error: e2 } = await admin
    .from("director_messages")
    .insert({
      workspace_id: WS,
      author: "director",
      author_function: "platform",
      body: "🛠️ Squashed a 500 on the portal path — all green again. Escorting the Acquisition goal: 3/5 milestones down 💪 @ceo I'll flag the next migration before I apply it.",
      kind: "update",
      mentions: ["ceo"],
      metadata: meta,
    })
    .select("id")
    .single();
  if (e2) throw e2;

  // 3. CEO reply threaded under Ada's update — proves threading + author='ceo'.
  const { error: e3 } = await admin.from("director_messages").insert({
    workspace_id: WS,
    author: "ceo",
    body: "Nice. @platform keep me posted on that migration — approve-gate it.",
    kind: "reply",
    parent_message_id: ada!.id,
    mentions: ["platform"],
    metadata: meta,
  });
  if (e3) throw e3;

  console.log(`✓ seeded #directors board (system ${sys!.id}, ada ${ada!.id} + CEO reply) for ${WS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
