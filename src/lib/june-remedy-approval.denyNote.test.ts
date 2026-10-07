/**
 * Phase 3 of cx-agents-read-engine-price-not-override-base.
 *
 * Pins the deny-note wording in `executeApprovedJuneRemedies`:
 *   - names the SPECIFIC parked remedy that was declined
 *   - explicitly disclaims it is NOT a ruling on other remedies for the ticket
 *   - never ships the old blanket "Founder DECLINED the refund/credit" wording,
 *     which June later read as a ticket-wide refund ban on 668bc5c8.
 *
 * Run:
 *   npx tsx --test src/lib/june-remedy-approval.denyNote.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { executeApprovedJuneRemedies } from "./june-remedy-approval";

type Row = {
  id: string;
  workspace_id: string;
  status: "approved" | "denied";
  tool_input: Record<string, unknown>;
};

function makeAdmin(rows: Row[]) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; row: Record<string, unknown> }> = [];
  const admin = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: unknown) {
              return {
                in(_c: string, _v: unknown[]) {
                  return {
                    async limit(_n: number) {
                      return table === "god_mode_approvals"
                        ? { data: rows, error: null }
                        : { data: [], error: null };
                    },
                  };
                },
              };
            },
          };
        },
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        update(row: Record<string, unknown>) {
          return {
            eq(_col: string, _val: unknown) {
              updates.push({ table, row });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  };
  return { admin, inserts, updates };
}

test("Phase 3: denied branch names the specific remedy summary AND disclaims it's not a ticket-wide refund ban", async () => {
  const { admin, inserts } = makeAdmin([
    {
      id: "approval-1",
      workspace_id: "ws-1",
      status: "denied",
      tool_input: {
        ticket_id: "ticket-1",
        remedy: {
          action_type: "partial_refund",
          payload: { amount_cents: 3000, order_number: "SC131156" },
          summary: "Refund the renewal she was double-charged on — the stale parked card from Oct 3rd",
        },
      },
    },
  ]);
  const counts = await executeApprovedJuneRemedies(admin as never);
  assert.equal(counts.denied, 1);
  assert.equal(counts.executed, 0);

  const note = inserts.find((i) => i.table === "ticket_messages");
  assert.ok(note, "a ticket_messages row must be inserted on the denied branch");
  const body = String(note!.row.body ?? "");

  // Scoped wording: names the remedy summary.
  assert.match(body, /declined this parked remedy/i);
  assert.ok(
    body.includes("Refund the renewal she was double-charged on"),
    `deny note must quote the remedy summary; got: ${body}`,
  );
  // Explicit non-blanket disclaimer.
  assert.match(body, /not a ruling on other remedies/i);
  // Old blanket wording is GONE.
  assert.ok(
    !/DECLINED the refund\/credit/i.test(body),
    `old blanket wording must not appear; got: ${body}`,
  );
});

test("Phase 3: denied branch falls back to a safe label when no remedy summary is on the card", async () => {
  const { admin, inserts } = makeAdmin([
    {
      id: "approval-2",
      workspace_id: "ws-1",
      status: "denied",
      tool_input: {
        ticket_id: "ticket-2",
        remedy: { action_type: "partial_refund", payload: { amount_cents: 2500 } },
      },
    },
  ]);
  const counts = await executeApprovedJuneRemedies(admin as never);
  assert.equal(counts.denied, 1);
  const body = String(inserts.find((i) => i.table === "ticket_messages")!.row.body ?? "");
  assert.match(body, /declined this parked remedy/i);
  assert.match(body, /not a ruling on other remedies/i);
  assert.ok(!/DECLINED the refund\/credit/i.test(body));
});
