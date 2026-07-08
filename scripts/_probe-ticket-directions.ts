// _probe-ticket-directions — the Phase 2 verification smoke test for the ticket-directions SDK
// (docs/brain/specs/sol-ticket-direction-artifact-and-first-touch-box-session.md § Phase 2).
//
// What it proves, end-to-end, against a real pair of throwaway workspace + ticket rows:
//   1. writeDirection inserts a LIVE Direction (superseded_at IS NULL) and returns the row.
//   2. getLiveDirection returns exactly that row.
//   3. A second writeDirection on the same ticket FAILS (23505 unique_violation) — the DB-level
//      partial UNIQUE (ticket_id) WHERE superseded_at IS NULL is the one-live-row invariant.
//   4. superseDirection compare-and-sets superseded_at on the live row and returns it.
//   5. A follow-up superseDirection returns null (no live row left — the compare-and-set on
//      superseded_at IS NULL is idempotent).
//   6. writeDirection succeeds AGAIN after the supersede (one live row per ticket, not one row
//      per ticket forever).
//   7. getLiveDirection reads back the fresh row, not the superseded one.
//
// Read-only against every table except ticket_directions (the SDK under test). Cleans up its own
// fixtures at the end. Run:
//   npx tsx scripts/_probe-ticket-directions.ts
import "./_bootstrap";
import { createAdminClient } from "./_bootstrap";
import { writeDirection, superseDirection, getLiveDirection } from "../src/lib/ticket-directions";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  const admin = createAdminClient();

  // Pick a real workspace to satisfy the FK; we use the first workspace's id + a synthetic ticket
  // row we insert + delete around the probe. This never mutates the workspace itself.
  const { data: ws } = await admin.from("workspaces").select("id").limit(1).maybeSingle();
  assert(ws?.id, "no workspaces row — cannot smoke-test (schema-only environment)");
  const workspaceId = ws.id as string;

  // A throwaway ticket row scoped to that workspace. `direction`/`channel` shape mirrors the
  // production defaults enough for the FK; we don't drive it end-to-end, just satisfy the FK.
  const { data: t, error: te } = await admin
    .from("tickets")
    .insert({ workspace_id: workspaceId, subject: "[probe-ticket-directions]", channel: "email", status: "new" })
    .select("id")
    .single();
  if (te) throw te;
  const ticketId = (t as { id: string }).id;
  console.log(`[probe] using workspace ${workspaceId.slice(0, 8)} + throwaway ticket ${ticketId.slice(0, 8)}`);

  try {
    // 1. writeDirection inserts one live row.
    const first = await writeDirection(admin, {
      workspace_id: workspaceId,
      ticket_id: ticketId,
      intent: "customer asks when their next box ships",
      context_summary: "active subscription; next order queued for next Monday",
      chosen_path: "stateless",
      plan: { action: "send_stateless_reply" },
      guardrails: { max_coupon_pct: 0 },
    });
    assert(first.superseded_at === null, "first row must be LIVE (superseded_at NULL)");
    assert(first.authored_by === "sol_box_session", "authored_by default must be sol_box_session");
    assert(first.chosen_path === "stateless", "chosen_path must round-trip");
    console.log(`✓ writeDirection inserted live row ${first.id.slice(0, 8)} (authored_by=${first.authored_by})`);

    // 2. getLiveDirection returns exactly that row.
    const live1 = await getLiveDirection(admin, ticketId);
    assert(live1 && live1.id === first.id, "getLiveDirection must return the just-inserted live row");
    console.log(`✓ getLiveDirection returned ${live1.id.slice(0, 8)}`);

    // 3. A second writeDirection on the same ticket errors on the DB-level partial UNIQUE.
    let raced = false;
    try {
      await writeDirection(admin, {
        workspace_id: workspaceId,
        ticket_id: ticketId,
        intent: "second live — should be rejected",
        context_summary: "should not land",
        chosen_path: "stateless",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      raced = /duplicate key value|23505|unique/i.test(msg);
      console.log(`✓ second writeDirection rejected by the partial UNIQUE: ${msg.slice(0, 120)}`);
    }
    assert(raced, "a second live writeDirection on the same ticket MUST error (partial UNIQUE)");

    // 4. superseDirection stamps superseded_at on the live row + returns it.
    const supersededRow = await superseDirection(admin, ticketId, { workspace_id: workspaceId });
    assert(supersededRow && supersededRow.id === first.id, "superseDirection must return the previously-live row");
    assert(supersededRow.superseded_at !== null, "supersededRow.superseded_at must be non-null");
    console.log(`✓ superseDirection stamped superseded_at on ${supersededRow.id.slice(0, 8)}`);

    // 5. A follow-up superseDirection returns null — no live row to supersede.
    const supersededAgain = await superseDirection(admin, ticketId, { workspace_id: workspaceId });
    assert(supersededAgain === null, "a follow-up superseDirection must return null (idempotent CAS)");
    console.log(`✓ follow-up superseDirection returned null (no live row)`);

    // 6. writeDirection succeeds AGAIN — one LIVE row per ticket, not one row per ticket forever.
    const second = await writeDirection(admin, {
      workspace_id: workspaceId,
      ticket_id: ticketId,
      intent: "customer pivoted the ask — now wants a refund",
      context_summary: "context refreshed post-inflection",
      chosen_path: "playbook",
      plan: { playbook_slug: "refund-with-recovery" },
      guardrails: { max_refund_cents: 3000 },
    });
    assert(second.id !== first.id, "second write must produce a NEW row (not update in place)");
    assert(second.superseded_at === null, "second row must be LIVE");
    console.log(`✓ writeDirection inserted a fresh live row ${second.id.slice(0, 8)} after supersede`);

    // 7. getLiveDirection reads back the fresh live row, not the superseded one.
    const live2 = await getLiveDirection(admin, ticketId);
    assert(live2 && live2.id === second.id, "getLiveDirection must return the FRESH live row post-supersede");
    console.log(`✓ getLiveDirection returned the fresh row ${live2.id.slice(0, 8)}`);

    console.log("\n✅ ticket-directions SDK smoke test passed — one-live-row invariant holds.");
  } finally {
    // Best-effort cleanup — ON DELETE CASCADE from tickets → ticket_directions removes the rows too.
    await admin.from("tickets").delete().eq("id", ticketId);
    console.log(`[probe] cleaned up throwaway ticket ${ticketId.slice(0, 8)}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
