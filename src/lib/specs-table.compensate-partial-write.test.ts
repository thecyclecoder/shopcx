/**
 * Unit tests for the compensating-write rail (spec-cannot-exist-without-phases Phase 2). Pins the shape
 * defect that produced the three stuck specs on 2026-07-20: `upsertSpec` commits the parent `specs` row
 * FIRST and then writes phases one at a time with NO cross-statement transaction (PostgREST). A phase-write
 * failure partway leaves the parent committed with no children — a phase-less spec that BUILDS but can never
 * MERGE. The compensating catch removes the parent row IFF this call was the one that INSERTED it (an
 * already-existing spec is NEVER deleted — a failed re-author must not destroy real work).
 *
 * Uses an in-memory fake Supabase admin passed via the `opts.admin` test seam; no live DB. Run:
 *   npx tsx --test src/lib/specs-table.compensate-partial-write.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { upsertSpec } from "@/lib/specs-table";

const WS = "00000000-0000-0000-0000-000000000000";

interface Row { [k: string]: unknown }
type Filters = Array<{ col: string; val: unknown }>;

function baseRow(slug: string) {
  return {
    slug,
    title: "T",
    summary: "s",
    owner: "platform",
    parent: "platform",
    blocked_by: [],
    priority: null,
    deferred: false,
    intended_status: null,
    auto_build: false,
    why: "w",
    what: "c",
  };
}
function basePhase(position: number) {
  return {
    position,
    title: `Phase ${position}`,
    body: "b",
    status: "planned" as const,
    verification: "vv",
    why: "w",
    what: "c",
  };
}

// ── Fake admin: `specs` table + a phase-insert that always throws ────────────────────────────────

interface FakeState {
  specs: Row[];
  /** Records IDs of specs the fake removed via `.from('specs').delete()` — the compensating write. */
  compensatedDeletes: string[];
}

function makeAdmin(state: FakeState) {
  let nextId = 1;
  function makeSpecsChain() {
    const filters: Filters = [];
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    };
    chain.maybeSingle = async () => {
      const match = state.specs.find((r) => filters.every((f) => r[f.col] === f.val));
      return { data: match ?? null, error: null };
    };
    chain.single = async () => {
      const match = state.specs.find((r) => filters.every((f) => r[f.col] === f.val));
      return { data: match ?? null, error: null };
    };
    chain.upsert = (payload: Row, _opts?: unknown) => {
      const existing = state.specs.find(
        (r) => r.workspace_id === payload.workspace_id && r.slug === payload.slug,
      );
      let id: string;
      if (existing) {
        id = String(existing.id);
        Object.assign(existing, payload);
      } else {
        id = `spec-${nextId++}`;
        state.specs.push({ id, ...payload });
      }
      const upChain: Record<string, unknown> = {
        select: () => upChain,
        single: async () => ({ data: { id }, error: null }),
      };
      return upChain;
    };
    chain.delete = () => {
      const delChain: Record<string, unknown> = {};
      const delFilters: Filters = [];
      delChain.eq = (col: string, val: unknown) => {
        delFilters.push({ col, val });
        // final `.eq` chain terminates when awaited
        (delChain as Record<string, unknown>).then = (
          resolve: (v: { data: null; error: null }) => void,
        ) => {
          const before = state.specs.length;
          state.specs = state.specs.filter((r) => !delFilters.every((f) => r[f.col] === f.val));
          const removed = before - state.specs.length;
          for (let i = 0; i < removed; i++) state.compensatedDeletes.push(String(val));
          resolve({ data: null, error: null });
        };
        return delChain;
      };
      return delChain;
    };
    return chain;
  }
  function makeSpecPhasesChain() {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    // read of existing phases → always empty (fresh spec)
    (chain as Record<string, unknown>).then = (
      resolve: (v: { data: Row[]; error: null }) => void,
    ) => resolve({ data: [], error: null });
    chain.insert = () => {
      const insChain: Record<string, unknown> = {
        select: () => insChain,
        // The failing state under test — every phase insert throws.
        single: async () => {
          throw new Error("simulated phase-write failure");
        },
      };
      return insChain;
    };
    return chain;
  }
  return {
    from(table: string) {
      if (table === "specs") return makeSpecsChain();
      if (table === "spec_phases") return makeSpecPhasesChain();
      throw new Error(`fake admin: unhandled table \`${table}\``);
    },
  } as unknown as Parameters<typeof upsertSpec>[3] extends infer O
    ? O extends { admin?: infer A }
      ? A
      : never
    : never;
}

test("phase-write failure on a NEW spec → parent `specs` row is compensated (deleted) and the ORIGINAL error re-throws", async () => {
  const state: FakeState = { specs: [], compensatedDeletes: [] };
  const admin = makeAdmin(state);
  await assert.rejects(
    () => upsertSpec(WS, baseRow("brand-new-spec"), [basePhase(1)], { admin }),
    (err: unknown) =>
      err instanceof Error && /simulated phase-write failure/.test((err as Error).message),
  );
  assert.equal(
    state.specs.length,
    0,
    "the newly-inserted parent row must be removed by the compensating catch — no phase-less spec left behind",
  );
  assert.equal(
    state.compensatedDeletes.length,
    1,
    "exactly one compensating delete should have fired (the one against the id we just inserted)",
  );
});

test("phase-write failure on an EXISTING spec → parent row is PRESERVED (a failed re-author must not destroy real work)", async () => {
  const state: FakeState = {
    specs: [{ id: "spec-existing", workspace_id: WS, slug: "already-here", status: null }],
    compensatedDeletes: [],
  };
  const admin = makeAdmin(state);
  await assert.rejects(
    () => upsertSpec(WS, baseRow("already-here"), [basePhase(1)], { admin }),
    (err: unknown) =>
      err instanceof Error && /simulated phase-write failure/.test((err as Error).message),
  );
  assert.equal(state.specs.length, 1, "the pre-existing spec row must survive the failed re-author");
  assert.equal(state.specs[0].id, "spec-existing");
  assert.equal(
    state.compensatedDeletes.length,
    0,
    "no compensating delete should fire on an EXISTING spec — that would destroy real work",
  );
});
