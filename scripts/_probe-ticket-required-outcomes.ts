// _probe-ticket-required-outcomes — the Phase 1 verification smoke test for the
// ticket-required-outcomes SDK (docs/brain/specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified.md § Phase 1).
//
// What it proves, end-to-end, against a real pair of throwaway workspace + ticket rows:
//   1. writeRequiredOutcomes inserts N rows for a handled ticket with N concrete asks — each
//      as a STRUCTURED row (not a prose blob), each with its own `expected_db_state` predicate.
//   2. listRequiredOutcomes returns the N rows in authored order.
//   3. Each row carries the expected DB state that would prove it done (the predicate is
//      non-empty and round-trips as jsonb).
//   4. hasUnverifiedOutcomes returns true while any item is not verified; the compare-and-set
//      transitions (pending → done → verified) drain the queue one row at a time.
//   5. A failed row is named on countOutcomesByStatus so the Phase-4 completion gate can
//      escalate with the specific unfinished items.
//
// Read-only against every table except ticket_required_outcomes + a throwaway ticket row it
// creates + deletes. Run against a real DB:
//   npx tsx scripts/_probe-ticket-required-outcomes.ts
import "./_bootstrap";
import { createAdminClient } from "./_bootstrap";
import {
  writeRequiredOutcomes,
  listRequiredOutcomes,
  markOutcomeDone,
  markOutcomeVerified,
  markOutcomeFailed,
  hasUnverifiedOutcomes,
  countOutcomesByStatus,
} from "../src/lib/ticket-required-outcomes";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  const admin = createAdminClient();

  const { data: ws } = await admin.from("workspaces").select("id").limit(1).maybeSingle();
  assert(ws?.id, "no workspaces row — cannot smoke-test (schema-only environment)");
  const workspaceId = ws.id as string;

  const { data: t, error: te } = await admin
    .from("tickets")
    .insert({ workspace_id: workspaceId, subject: "[probe-ticket-required-outcomes]", channel: "email", status: "new" })
    .select("id")
    .single();
  if (te) throw te;
  const ticketId = (t as { id: string }).id;
  console.log(`[probe] using workspace ${workspaceId.slice(0, 8)} + throwaway ticket ${ticketId.slice(0, 8)}`);

  try {
    // 1. Distill Judy's original ask ("add a 2nd bag + apply $15 credit") into TWO structured rows.
    const inserted = await writeRequiredOutcomes(admin, {
      workspace_id: workspaceId,
      ticket_id: ticketId,
      items: [
        {
          kind: "add_bag_to_next_order",
          description: "Add a second bag of chocolate to Judy's next queued order",
          target_ids: { contract_id: "gid://shopify/SubscriptionContract/EXAMPLE" },
          expected_db_state: {
            table: "subscriptions",
            match: { shopify_contract_id: "gid://shopify/SubscriptionContract/EXAMPLE" },
            predicate: "line_items includes chocolate variant",
          },
        },
        {
          kind: "apply_coupon",
          description: "Apply a one-time $15 credit to Judy's next order",
          target_ids: { contract_id: "gid://shopify/SubscriptionContract/EXAMPLE", code: "JUDY15" },
          expected_db_state: {
            table: "subscriptions",
            match: { shopify_contract_id: "gid://shopify/SubscriptionContract/EXAMPLE" },
            column: "applied_discounts",
            expected_contains: { title: "JUDY15" },
          },
        },
      ],
    });
    assert(inserted.length === 2, "writeRequiredOutcomes must return the two inserted rows");
    assert(inserted[0].status === "pending" && inserted[1].status === "pending", "new rows default to pending");
    assert(
      Object.keys(inserted[0].expected_db_state).length > 0 &&
        Object.keys(inserted[1].expected_db_state).length > 0,
      "each row must carry its expected_db_state predicate — the 'what would prove this done' shape",
    );
    console.log(`✓ writeRequiredOutcomes inserted 2 structured rows for Judy's ask`);

    // 2. listRequiredOutcomes returns the rows in authored order.
    const listed = await listRequiredOutcomes(admin, ticketId, { workspace_id: workspaceId });
    assert(listed.length === 2, "listRequiredOutcomes must return the two rows");
    assert(
      listed[0].id === inserted[0].id && listed[1].id === inserted[1].id,
      "listRequiredOutcomes must preserve authored order",
    );
    console.log(`✓ listRequiredOutcomes returned 2 rows in authored order (${listed.map((r) => r.kind).join(", ")})`);

    // 3. Gate: any unverified outcome → hasUnverifiedOutcomes=true.
    assert(await hasUnverifiedOutcomes(admin, ticketId, workspaceId), "gate must be OPEN while items are pending");
    console.log(`✓ hasUnverifiedOutcomes=true while items are pending`);

    // 4. Drain the queue one row at a time — CAS transitions guard against stale writers.
    const done0 = await markOutcomeDone(admin, { id: inserted[0].id, workspace_id: workspaceId });
    assert(done0 && done0.status === "done", "markOutcomeDone must move pending → done");
    const verified0 = await markOutcomeVerified(admin, { id: inserted[0].id, workspace_id: workspaceId });
    assert(verified0 && verified0.status === "verified" && verified0.verified_at, "markOutcomeVerified must stamp verified_at");
    console.log(`✓ item 0 drained pending → done → verified`);
    assert(await hasUnverifiedOutcomes(admin, ticketId, workspaceId), "gate must stay OPEN while item 1 is pending");

    // 5. Item 1 fails — completion gate must name it in the count breakdown.
    const failed1 = await markOutcomeFailed(admin, {
      id: inserted[1].id,
      workspace_id: workspaceId,
      reason: "coupon executor refused: applied_discounts already contains JUDY15",
    });
    assert(failed1 && failed1.status === "failed" && failed1.failed_reason, "markOutcomeFailed must stamp failed_reason");
    const counts = await countOutcomesByStatus(admin, ticketId, workspaceId);
    assert(counts.verified === 1 && counts.failed === 1 && counts.pending === 0 && counts.done === 0,
      `countOutcomesByStatus must break down by status — got ${JSON.stringify(counts)}`);
    console.log(`✓ item 1 failed with reason; counts=${JSON.stringify(counts)}`);

    // Idempotency: a stale-status CAS returns null instead of clobbering.
    const staleDone = await markOutcomeDone(admin, { id: inserted[0].id, workspace_id: workspaceId });
    assert(staleDone === null, "markOutcomeDone from pending on a row already verified must return null (CAS lost)");
    console.log(`✓ CAS guard rejects stale transition (item 0 already verified)`);

    console.log("\n✅ ticket-required-outcomes SDK smoke test passed — structured checklist holds.");
  } finally {
    await admin.from("tickets").delete().eq("id", ticketId);
    console.log(`[probe] cleaned up throwaway ticket ${ticketId.slice(0, 8)}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
