/**
 * Unit tests for `applySolLinkProposal` — Phase 2 of
 * docs/brain/specs/account-linking-address-aware-confidence-graded-and-cs-searchable.md.
 *
 * The wedge is ticket db8b3d66: a HIGH-confidence unlinked sibling carries the real sub / disputed
 * order, so the remedy must run against the LINKED PERSON, not the empty half. Phase 2 makes the
 * link a first-class Direction proposal Sol / June writes and the worker executes BEFORE the
 * remedy dispatches. The tests pin the four non-negotiables:
 *
 *   1. HIGH sibling + no rejection → linked (both customer_ids share one customer_links group).
 *   2. HIGH sibling + previously_rejected + reconfirmed=true → linked, stale rejection cleared.
 *   3. HIGH sibling + previously_rejected + reconfirmed=undefined → REFUSED (needs_reconfirm).
 *   4. LOW proposal → surface-only (never auto-linked, low_confidence_skipped).
 *   5. Idempotent: applying twice returns already_linked without a duplicate row.
 *   6. Same-customer / candidate-not-in-workspace → refused with the right typed reason.
 *
 * Run: npx tsx --test src/lib/sol-link-proposal.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applySolLinkProposal } from "./sol-link-proposal";
import type { TicketDirectionLinkProposal } from "./ticket-directions";

interface FakeCustomer {
  id: string;
  workspace_id: string;
  email: string | null;
}
interface FakeLink {
  customer_id: string;
  workspace_id: string;
  group_id: string;
  is_primary: boolean;
}
interface FakeRejection {
  customer_id: string;
  rejected_customer_id: string;
}
interface FakeMessage {
  ticket_id: string;
  direction: string;
  visibility: string;
  author_type: string;
  body: string;
}

interface SeedInput {
  customers?: FakeCustomer[];
  links?: FakeLink[];
  rejections?: FakeRejection[];
}

function makeAdmin(seed: SeedInput = {}) {
  const state = {
    customers: (seed.customers ?? []).map((c) => ({ ...c })),
    links: (seed.links ?? []).map((l) => ({ ...l })),
    rejections: (seed.rejections ?? []).map((r) => ({ ...r })),
    messages: [] as FakeMessage[],
  };

  function makeCustomersBuilder() {
    const filters: Record<string, unknown> = {};
    const builder = {
      select(_cols: string) { return builder; },
      eq(col: string, val: unknown) { filters[col] = val; return builder; },
      maybeSingle() {
        const match = state.customers.find((c) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((c as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        });
        return Promise.resolve({ data: match ? { id: match.id, email: match.email } : null, error: null });
      },
    };
    return builder;
  }

  function makeLinksBuilder() {
    const filters: Record<string, unknown> = {};
    const upsertQueue: Array<{ payload: FakeLink; opts?: { onConflict?: string } }> = [];
    const updateQueue: Array<Record<string, unknown>> = [];
    const builder = {
      select(_cols: string) { return builder; },
      eq(col: string, val: unknown) { filters[col] = val; return builder; },
      maybeSingle() {
        const match = state.links.find((l) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((l as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        });
        return Promise.resolve({
          data: match ? { group_id: match.group_id, is_primary: match.is_primary, customer_id: match.customer_id } : null,
          error: null,
        });
      },
      upsert(payload: FakeLink, opts?: { onConflict?: string }) {
        upsertQueue.push({ payload, opts });
        // Simulate onConflict: customer_id — replace if existing.
        const existingIdx = state.links.findIndex((l) => l.customer_id === payload.customer_id);
        if (existingIdx >= 0) state.links[existingIdx] = { ...payload };
        else state.links.push({ ...payload });
        return Promise.resolve({ data: null, error: null });
      },
      update(patch: Record<string, unknown>) {
        updateQueue.push(patch);
        return {
          eq(col: string, val: unknown) {
            filters[col] = val;
            const idx = state.links.findIndex((l) => {
              for (const [k, v] of Object.entries(filters)) {
                if ((l as unknown as Record<string, unknown>)[k] !== v) return false;
              }
              return true;
            });
            if (idx >= 0) state.links[idx] = { ...state.links[idx], ...(patch as Partial<FakeLink>) };
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
    return builder;
  }

  function makeRejectionsBuilder() {
    const filters: Record<string, unknown> = {};
    const builder = {
      select(_cols: string) { return builder; },
      eq(col: string, val: unknown) { filters[col] = val; return builder; },
      delete() {
        return {
          eq(col: string, val: unknown) {
            filters[col] = val;
            const before = state.rejections.length;
            state.rejections = state.rejections.filter((r) => {
              for (const [k, v] of Object.entries(filters)) {
                if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
              }
              return false;
            });
            return {
              eq(col2: string, val2: unknown) {
                filters[col2] = val2;
                state.rejections = state.rejections.slice(0, before).filter((r) => {
                  for (const [k, v] of Object.entries(filters)) {
                    if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
                  }
                  return false;
                });
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      },
    };
    return builder;
  }

  function makeMessagesBuilder() {
    return {
      insert(payload: FakeMessage) {
        state.messages.push({ ...payload });
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  const admin = {
    from(table: string) {
      if (table === "customers") return makeCustomersBuilder();
      if (table === "customer_links") return makeLinksBuilder();
      if (table === "customer_link_rejections") return makeRejectionsBuilder();
      if (table === "ticket_messages") return makeMessagesBuilder();
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { admin: admin as unknown as import("@supabase/supabase-js").SupabaseClient, state };
}

const WS = "00000000-0000-0000-0000-0000000000ws";
const TICKET = "11111111-2222-3333-4444-555555555555";
const OWN = "cust-liz";
const SIB = "cust-rustin";

const proposal = (over: Partial<TicketDirectionLinkProposal> = {}): TicketDirectionLinkProposal => ({
  candidate_customer_id: SIB,
  confidence: "high",
  signals: ["name", "address"],
  reason: "same last name + same street address",
  ...over,
});

test("HIGH sibling + no rejection → linked (both customers share one group)", async () => {
  const { admin, state } = makeAdmin({
    customers: [
      { id: OWN, workspace_id: WS, email: "lizjohnson062@gmail.com" },
      { id: SIB, workspace_id: WS, email: "rustin94@gmail.com" },
    ],
  });
  const res = await applySolLinkProposal(admin, {
    workspaceId: WS,
    ticketId: TICKET,
    ticketCustomerId: OWN,
    proposal: proposal(),
  });
  assert.equal(res.linked, true);
  assert.equal(res.reason, "linked");
  assert.equal(res.reconfirm_applied, false);
  assert.ok(res.group_id, "group_id must be set on link");
  const own = state.links.find((l) => l.customer_id === OWN);
  const sib = state.links.find((l) => l.customer_id === SIB);
  assert.ok(own && sib, "both link rows must exist");
  assert.equal(own!.group_id, sib!.group_id, "both must share the same group_id");
  assert.equal(own!.is_primary, true);
  assert.equal(sib!.is_primary, false);
  assert.equal(state.messages.length, 1, "one internal ticket_messages note must be stamped");
});

test("HIGH sibling + previously_rejected + reconfirmed=true → linked + rejection cleared", async () => {
  const { admin, state } = makeAdmin({
    customers: [
      { id: OWN, workspace_id: WS, email: "lizjohnson062@gmail.com" },
      { id: SIB, workspace_id: WS, email: "rustin94@gmail.com" },
    ],
    rejections: [{ customer_id: OWN, rejected_customer_id: SIB }],
  });
  const res = await applySolLinkProposal(admin, {
    workspaceId: WS,
    ticketId: TICKET,
    ticketCustomerId: OWN,
    proposal: proposal({ previously_rejected: true, reconfirmed: true }),
  });
  assert.equal(res.linked, true);
  assert.equal(res.reason, "reconfirmed");
  assert.equal(res.reconfirm_applied, true);
  assert.equal(state.rejections.length, 0, "stale rejection must be cleared on re-confirm");
  assert.equal(state.messages[0].body.includes("re-confirmed"), true, "note must cite re-confirm");
});

test("HIGH sibling + previously_rejected + reconfirmed=undefined → REFUSED (needs_reconfirm)", async () => {
  const { admin, state } = makeAdmin({
    customers: [
      { id: OWN, workspace_id: WS, email: "liz@x.com" },
      { id: SIB, workspace_id: WS, email: "rus@x.com" },
    ],
    rejections: [{ customer_id: OWN, rejected_customer_id: SIB }],
  });
  const res = await applySolLinkProposal(admin, {
    workspaceId: WS,
    ticketId: TICKET,
    ticketCustomerId: OWN,
    proposal: proposal({ previously_rejected: true }),
  });
  assert.equal(res.linked, false, "a previously_rejected pair without reconfirm must NEVER silently link");
  assert.equal(res.reason, "needs_reconfirm");
  assert.equal(state.links.length, 0, "no customer_links row must be written");
  assert.equal(state.rejections.length, 1, "the rejection row must be preserved");
  assert.equal(state.messages.length, 0, "no note must be stamped on a refusal");
});

test("LOW confidence → surface-only, never auto-linked", async () => {
  const { admin, state } = makeAdmin({
    customers: [
      { id: OWN, workspace_id: WS, email: "a@x.com" },
      { id: SIB, workspace_id: WS, email: "b@x.com" },
    ],
  });
  const res = await applySolLinkProposal(admin, {
    workspaceId: WS,
    ticketId: TICKET,
    ticketCustomerId: OWN,
    proposal: proposal({ confidence: "low", signals: ["name"] }),
  });
  assert.equal(res.linked, false);
  assert.equal(res.reason, "low_confidence_skipped");
  assert.equal(state.links.length, 0, "low-confidence proposal must never write a link row");
});

test("Idempotent: applying twice on an already-linked pair returns already_linked without a duplicate", async () => {
  const { admin, state } = makeAdmin({
    customers: [
      { id: OWN, workspace_id: WS, email: "a@x.com" },
      { id: SIB, workspace_id: WS, email: "b@x.com" },
    ],
    links: [
      { customer_id: OWN, workspace_id: WS, group_id: "grp-1", is_primary: true },
      { customer_id: SIB, workspace_id: WS, group_id: "grp-1", is_primary: false },
    ],
  });
  const res = await applySolLinkProposal(admin, {
    workspaceId: WS,
    ticketId: TICKET,
    ticketCustomerId: OWN,
    proposal: proposal(),
  });
  assert.equal(res.linked, true);
  assert.equal(res.reason, "already_linked");
  assert.equal(state.links.length, 2, "no duplicate link rows may be written");
  assert.equal(state.messages.length, 0, "no note must be stamped when nothing changed");
});

test("Same-customer proposal → refused", async () => {
  const { admin } = makeAdmin({
    customers: [{ id: OWN, workspace_id: WS, email: "a@x.com" }],
  });
  const res = await applySolLinkProposal(admin, {
    workspaceId: WS,
    ticketId: TICKET,
    ticketCustomerId: OWN,
    proposal: proposal({ candidate_customer_id: OWN }),
  });
  assert.equal(res.linked, false);
  assert.equal(res.reason, "same_customer");
});

test("Candidate not in workspace → refused (workspace scope re-asserted at the applier)", async () => {
  const { admin, state } = makeAdmin({
    customers: [
      { id: OWN, workspace_id: WS, email: "a@x.com" },
      { id: SIB, workspace_id: "other-workspace", email: "b@x.com" },
    ],
  });
  const res = await applySolLinkProposal(admin, {
    workspaceId: WS,
    ticketId: TICKET,
    ticketCustomerId: OWN,
    proposal: proposal(),
  });
  assert.equal(res.linked, false);
  assert.equal(res.reason, "candidate_not_in_workspace");
  assert.equal(state.links.length, 0);
});
