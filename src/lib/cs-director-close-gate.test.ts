/**
 * Unit tests for `loadInboundMessagesForCloseGate` — the cross-tenant guard on the pre-close
 * read used by [[../../scripts/builder-worker.ts]] `runCsDirectorCallJob` for the
 * `close_no_action` gate.
 *
 * The invariant pinned: `ticket_messages` has NO `workspace_id` column of its own, so a
 * bare `.eq('ticket_id', …)` read would succeed for a ticket owned by ANY workspace. The
 * fix is a PostgREST `tickets!inner` join with a `tickets.workspace_id` filter — the ticket
 * row MUST belong to the caller's workspace or the message set is empty. Mirrors the
 * Phase 5 tests in [[./inflection-detector.reSessionSol.test]].
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/cs-director-close-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadInboundMessagesForCloseGate } from "./cs-director-close-gate";

interface FakeTicket {
  id: string;
  workspace_id: string;
}

interface FakeTicketMessage {
  id: string;
  ticket_id: string;
  direction: string;
  author_type: string;
  visibility: string | null;
  body: string | null;
  body_clean: string | null;
  created_at: string;
}

interface SeedInput {
  tickets: FakeTicket[];
  ticket_messages: FakeTicketMessage[];
}

function makeAdmin(seed: SeedInput) {
  const tickets = seed.tickets.map((t) => ({ ...t }));
  const ticket_messages = seed.ticket_messages.map((m) => ({ ...m }));

  function fromTicketMessages() {
    const filters: Record<string, unknown> = {};
    const parentFilters: Record<string, Record<string, unknown>> = {};
    let orderAsc = true;
    const builder = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        // A `tickets.workspace_id` filter is a join-side predicate against the parent
        // ticket row, not a column on ticket_messages — same stub shape used in
        // src/lib/inflection-detector.reSessionSol.test.ts for the Phase 5 guard.
        const dot = col.indexOf(".");
        if (dot > 0) {
          const parent = col.slice(0, dot);
          const key = col.slice(dot + 1);
          parentFilters[parent] = parentFilters[parent] ?? {};
          parentFilters[parent]![key] = val;
          return builder;
        }
        filters[col] = val;
        return builder;
      },
      order(_col: string, opts?: { ascending?: boolean }) {
        orderAsc = opts?.ascending !== false;
        const rows = ticket_messages.filter((m) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((m as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          // Enforce the tickets!inner join: the message's parent ticket must exist AND
          // match every parent-column predicate. A foreign-workspace parent is filtered.
          for (const [parent, preds] of Object.entries(parentFilters)) {
            if (parent !== "tickets") continue;
            const parentRow = tickets.find(
              (t) => t.id === (m as unknown as { ticket_id?: string }).ticket_id,
            );
            if (!parentRow) return false;
            for (const [pk, pv] of Object.entries(preds)) {
              if ((parentRow as unknown as Record<string, unknown>)[pk] !== pv) return false;
            }
          }
          return true;
        });
        const sorted = rows.slice().sort((a, b) => {
          if (a.created_at === b.created_at) return 0;
          const less = a.created_at < b.created_at;
          return orderAsc ? (less ? -1 : 1) : (less ? 1 : -1);
        });
        return Promise.resolve({
          data: sorted.map((r) => ({
            id: r.id,
            direction: r.direction,
            author_type: r.author_type,
            visibility: r.visibility,
            body: r.body,
            body_clean: r.body_clean,
            created_at: r.created_at,
          })),
          error: null,
        });
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "ticket_messages") return fromTicketMessages();
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return admin as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const WS = "00000000-0000-0000-0000-0000000000ws";
const FOREIGN_WS = "77777777-0000-0000-0000-0000000000ws";
const TID = "11111111-2222-3333-4444-555555555555";

test("Phase 1 security: a ticket_id whose parent ticket belongs to a FOREIGN workspace returns an empty inbound message set (the close_no_action gate cannot read a foreign tenant's customer messages)", async () => {
  const admin = makeAdmin({
    // Ticket belongs to the foreign workspace — the caller passes WS as its scope.
    tickets: [{ id: TID, workspace_id: FOREIGN_WS }],
    ticket_messages: [
      {
        id: "msg-foreign",
        ticket_id: TID,
        direction: "inbound",
        author_type: "customer",
        visibility: "external",
        body: "secret-cross-tenant-text",
        body_clean: "secret-cross-tenant-text",
        created_at: "2026-10-01T12:00:00Z",
      },
    ],
  });
  const msgs = await loadInboundMessagesForCloseGate(admin, WS, TID);
  assert.deepEqual(
    msgs,
    [],
    "a foreign-workspace ticket_id must return an empty inbound message set — no cross-workspace leak",
  );
});

test("Phase 1 positive case: a ticket_id in the CALLER's workspace surfaces its inbound customer messages ascending by created_at", async () => {
  const admin = makeAdmin({
    tickets: [{ id: TID, workspace_id: WS }],
    ticket_messages: [
      {
        id: "msg-newer",
        ticket_id: TID,
        direction: "inbound",
        author_type: "customer",
        visibility: "external",
        body: "second ask",
        body_clean: "second ask",
        created_at: "2026-10-01T13:00:00Z",
      },
      {
        id: "msg-older",
        ticket_id: TID,
        direction: "inbound",
        author_type: "customer",
        visibility: "external",
        body: "first ask",
        body_clean: "first ask",
        created_at: "2026-10-01T12:00:00Z",
      },
      // Noise rows the filter chain must reject.
      {
        id: "msg-outbound",
        ticket_id: TID,
        direction: "outbound",
        author_type: "ai",
        visibility: "external",
        body: "ignored",
        body_clean: "ignored",
        created_at: "2026-10-01T12:30:00Z",
      },
      {
        id: "msg-staff",
        ticket_id: TID,
        direction: "inbound",
        author_type: "staff",
        visibility: "internal",
        body: "note",
        body_clean: "note",
        created_at: "2026-10-01T12:45:00Z",
      },
    ],
  });
  const msgs = await loadInboundMessagesForCloseGate(admin, WS, TID);
  assert.equal(msgs.length, 2, "only inbound+customer messages pass");
  assert.equal(msgs[0]!.id, "msg-older", "ascending by created_at");
  assert.equal(msgs[1]!.id, "msg-newer");
});
