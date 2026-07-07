/**
 * Unit tests for Phase 3 — the compiled library wired as a durable input to
 * Sol's selection (spec: playbook-compiler-becomes-box-agent-mining-full-history).
 *
 * Pins:
 *   (a) `buildCompiledLibraryPromptSection` — the pure formatter renders
 *       BOTH sub-sections (approved playbooks + persisted trees) and returns
 *       the empty string when neither exists (never a false "(none)" line
 *       that reads as "no data" to the direction-setting session).
 *   (b) `listApprovedCompiledPlaybooks` + `listCompiledTrees` — the DB-driven
 *       filter predicates are exactly what the spec's Phase 3 verification
 *       bullet promises: approved (is_active=true, proposed_by IS NULL,
 *       source_tree_key IS NOT NULL) shows up; a still-proposed seed does
 *       NOT; a retired one does NOT.
 *   (c) `loadCompiledLibraryPromptSection` — the wire helper composes the
 *       two reads + the formatter; a workspace with zero approved
 *       playbooks AND zero trees still returns `""` (Sol's system prompt
 *       stays byte-clean).
 *
 * The (b) tests use a small in-memory Supabase stub: it exposes only the
 * `.from(...)` chain shape the two readers actually call, and records the
 * chain so the tests can assert the exact predicates a raw regex on the
 * source file could not.
 *
 * Run: `npx tsx --test src/lib/playbook-compiler-sol.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompiledLibraryPromptSection,
  listApprovedCompiledPlaybooks,
  listCompiledTrees,
  loadCompiledLibraryPromptSection,
  type ApprovedCompiledPlaybook,
  type CompiledTreeRow,
} from "./playbook-compiler";

// ── (a) pure formatter tests ─────────────────────────────────────────────

const WS = "00000000-0000-0000-0000-000000000001";

function approved(overrides: Partial<ApprovedCompiledPlaybook> = {}): ApprovedCompiledPlaybook {
  return {
    id: "pb-1",
    name: "Compiler seed — melted_in_transit → partial_refund + replacement",
    description: "42 tickets landed here",
    trigger_intents: ["product_damaged_in_transit", "melted_arrival"],
    trigger_patterns: ["melted_in_transit"],
    source_tree_key: "melted_in_transit :: partial_refund+replacement",
    priority: 0,
    ...overrides,
  };
}

function treeRow(overrides: Partial<CompiledTreeRow> = {}): CompiledTreeRow {
  return {
    id: "ct-1",
    tree_key: "melted_in_transit :: partial_refund+replacement",
    problem: "melted_in_transit",
    action_types: ["partial_refund", "replacement"],
    support: 42,
    intent_distribution: { product_damaged_in_transit: 30, melted_arrival: 12 },
    reasoning: "42 confirmed tickets",
    compiled_at: "2026-07-07T00:00:00Z",
    ...overrides,
  };
}

test("buildCompiledLibraryPromptSection: empty inputs → empty string (never a '(none)' line)", () => {
  assert.equal(buildCompiledLibraryPromptSection([], []), "");
});

test("buildCompiledLibraryPromptSection: approved playbooks section names each seed + its source_tree_key", () => {
  const out = buildCompiledLibraryPromptSection([approved()], []);
  assert.match(out, /COMPILED LIBRARY/);
  assert.match(out, /Approved compiler-derived playbooks/);
  assert.match(out, /tree_key=melted_in_transit :: partial_refund\+replacement/);
  assert.match(out, /product_damaged_in_transit, melted_arrival/);
});

test("buildCompiledLibraryPromptSection: trees section carries problem → actions + support + top intents", () => {
  const out = buildCompiledLibraryPromptSection([], [treeRow()]);
  assert.match(out, /Persisted trees/);
  assert.match(out, /melted_in_transit → partial_refund \+ replacement/);
  assert.match(out, /support=42/);
  assert.match(out, /product_damaged_in_transit\(30\)/);
});

test("buildCompiledLibraryPromptSection: renders BOTH sub-sections together", () => {
  const out = buildCompiledLibraryPromptSection([approved()], [treeRow()]);
  assert.match(out, /Approved compiler-derived playbooks/);
  assert.match(out, /Persisted trees/);
  // Ordering: approved first, trees second — matches Sol's "prefer approved" cue.
  const approvedIdx = out.indexOf("Approved compiler-derived playbooks");
  const treesIdx = out.indexOf("Persisted trees");
  assert.ok(approvedIdx >= 0 && treesIdx > approvedIdx, "approved playbooks must render before persisted trees");
});

// ── (b) reader predicate + DB-driven behavior tests via a Supabase stub ──

type StubCall = { table: string; op: string; args: unknown };

interface StubBuilder {
  select: (cols: string) => StubBuilder;
  eq: (col: string, val: unknown) => StubBuilder;
  is: (col: string, val: unknown) => StubBuilder;
  not: (col: string, op: string, val: unknown) => StubBuilder;
  gte: (col: string, val: unknown) => StubBuilder;
  order: (col: string, opts?: { ascending?: boolean }) => StubBuilder;
  limit: (n: number) => StubBuilder;
  // The stub resolves once awaited (thenable — Supabase's own builders behave this way).
  then: (onFulfilled: (r: { data: unknown[] | null }) => unknown, onRejected?: (e: unknown) => unknown) => Promise<unknown>;
}

function makeStub(fixtures: {
  playbooks: Array<Record<string, unknown>>;
  compiled_trees: Array<Record<string, unknown>>;
}, calls: StubCall[]) {
  return {
    from(table: string) {
      const filters: Array<{ op: string; col: string; val?: unknown; val2?: unknown }> = [];
      const orders: Array<{ col: string; ascending: boolean }> = [];
      let cap: number | null = null;
      const b: StubBuilder = {
        select(cols) { calls.push({ table, op: "select", args: cols }); return b; },
        eq(col, val) { calls.push({ table, op: "eq", args: [col, val] }); filters.push({ op: "eq", col, val }); return b; },
        is(col, val) { calls.push({ table, op: "is", args: [col, val] }); filters.push({ op: "is", col, val }); return b; },
        not(col, op, val) { calls.push({ table, op: "not", args: [col, op, val] }); filters.push({ op: "not-is-null", col, val }); return b; },
        gte(col, val) { calls.push({ table, op: "gte", args: [col, val] }); filters.push({ op: "gte", col, val }); return b; },
        order(col, opts) { orders.push({ col, ascending: opts?.ascending !== false }); return b; },
        limit(n) { cap = n; return b; },
        async then(onFulfilled) {
          // Apply filters over the fixture rows.
          const src = table === "playbooks" ? fixtures.playbooks : fixtures.compiled_trees;
          const filtered = src.filter((row) => {
            for (const f of filters) {
              if (f.op === "eq") { if (row[f.col] !== f.val) return false; }
              else if (f.op === "is") {
                // .is('col', null)
                if (f.val === null && row[f.col] !== null && row[f.col] !== undefined) return false;
              } else if (f.op === "not-is-null") {
                // .not('col', 'is', null) → col IS NOT NULL
                if (row[f.col] === null || row[f.col] === undefined) return false;
              } else if (f.op === "gte") {
                if (typeof row[f.col] !== "number" || (row[f.col] as number) < (f.val as number)) return false;
              }
            }
            return true;
          });
          // apply orders (last order wins on numeric comparison for tests) — quick lexicographic first-order sort:
          if (orders.length > 0) {
            filtered.sort((a, b) => {
              for (const o of orders) {
                const av = a[o.col]; const bv = b[o.col];
                if (av === bv) continue;
                if ((av as string | number) < (bv as string | number)) return o.ascending ? -1 : 1;
                return o.ascending ? 1 : -1;
              }
              return 0;
            });
          }
          const capped = cap != null ? filtered.slice(0, cap) : filtered;
          return onFulfilled({ data: capped });
        },
      };
      return b;
    },
  };
}

test("listApprovedCompiledPlaybooks: predicate matches spec — is_active=true, proposed_by IS NULL, source_tree_key IS NOT NULL", async () => {
  const calls: StubCall[] = [];
  const stub = makeStub({
    playbooks: [
      // approved compiler seed — MUST show up
      { id: "pb-approved", workspace_id: WS, name: "Compiler seed A", description: null, trigger_intents: ["a"], trigger_patterns: [], source_tree_key: "a :: x", priority: 0, is_active: true, proposed_by: null },
      // proposed compiler seed — MUST NOT show up (awaiting approval)
      { id: "pb-proposed", workspace_id: WS, name: "Compiler seed B", description: null, trigger_intents: [], trigger_patterns: [], source_tree_key: "b :: y", priority: 0, is_active: false, proposed_by: "playbook_compiler" },
      // retired compiler seed — MUST NOT show up (is_active=false)
      { id: "pb-retired", workspace_id: WS, name: "Retired seed", description: null, trigger_intents: [], trigger_patterns: [], source_tree_key: "c :: z", priority: 0, is_active: false, proposed_by: null },
      // human-authored active playbook — MUST NOT show up (source_tree_key IS NULL)
      { id: "pb-human", workspace_id: WS, name: "Human authored", description: null, trigger_intents: [], trigger_patterns: [], source_tree_key: null, priority: 0, is_active: true, proposed_by: null },
      // cross-workspace approved seed — MUST NOT show up
      { id: "pb-cross", workspace_id: "other-ws", name: "Cross ws seed", description: null, trigger_intents: [], trigger_patterns: [], source_tree_key: "x :: y", priority: 0, is_active: true, proposed_by: null },
    ],
    compiled_trees: [],
  }, calls);
  // deno-lint-ignore no-explicit-any
  const rows = await listApprovedCompiledPlaybooks(stub as any, WS);
  assert.equal(rows.length, 1, "only the approved compiler seed for THIS workspace should surface");
  assert.equal(rows[0].id, "pb-approved");
  // predicate assertions on the exact chain the reader constructed:
  const eqCalls = calls.filter((c) => c.op === "eq" && c.table === "playbooks").map((c) => c.args);
  const isCalls = calls.filter((c) => c.op === "is" && c.table === "playbooks").map((c) => c.args);
  const notCalls = calls.filter((c) => c.op === "not" && c.table === "playbooks").map((c) => c.args);
  assert.deepEqual(eqCalls, [["workspace_id", WS], ["is_active", true]], "workspace_id + is_active=true");
  assert.deepEqual(isCalls, [["proposed_by", null]], "proposed_by IS NULL");
  assert.deepEqual(notCalls, [["source_tree_key", "is", null]], "source_tree_key IS NOT NULL");
});

test("listApprovedCompiledPlaybooks: DB-driven — flipping is_active=false empties the option set (spec Phase 3 verification bullet)", async () => {
  const fixtures = {
    playbooks: [
      { id: "pb-approved", workspace_id: WS, name: "Seed", description: null, trigger_intents: [], trigger_patterns: [], source_tree_key: "a :: b", priority: 0, is_active: true, proposed_by: null },
    ],
    compiled_trees: [],
  };
  // deno-lint-ignore no-explicit-any
  const stub1 = makeStub(fixtures, []) as any;
  assert.equal((await listApprovedCompiledPlaybooks(stub1, WS)).length, 1, "sanity: approved seed shows up");
  // Retire the seed → Sol's option set MUST lose it (no hardcoding).
  fixtures.playbooks[0].is_active = false;
  const stub2 = makeStub(fixtures, []) as unknown as Parameters<typeof listApprovedCompiledPlaybooks>[0];
  assert.equal((await listApprovedCompiledPlaybooks(stub2, WS)).length, 0, "retiring the seed removes it from Sol's option set");
});

test("listCompiledTrees: predicate + limit — highest-support first, minSupport respected", async () => {
  const calls: StubCall[] = [];
  const stub = makeStub({
    playbooks: [],
    compiled_trees: [
      { id: "t-hi", workspace_id: WS, tree_key: "a :: x", problem: "a", action_types: ["x"], support: 50, intent_distribution: {}, reasoning: null, compiled_at: "2026-07-01" },
      { id: "t-mid", workspace_id: WS, tree_key: "b :: y", problem: "b", action_types: ["y"], support: 20, intent_distribution: {}, reasoning: null, compiled_at: "2026-07-01" },
      { id: "t-low", workspace_id: WS, tree_key: "c :: z", problem: "c", action_types: ["z"], support: 5, intent_distribution: {}, reasoning: null, compiled_at: "2026-07-01" },
    ],
  }, calls);
  // deno-lint-ignore no-explicit-any
  const rows = await listCompiledTrees(stub as any, WS, { limit: 2, minSupport: 15 });
  assert.equal(rows.length, 2, "limit=2 caps the result");
  assert.equal(rows[0].id, "t-hi", "highest-support first");
  assert.equal(rows[1].id, "t-mid", "minSupport=15 excludes t-low");
  const gteCalls = calls.filter((c) => c.op === "gte" && c.table === "compiled_trees").map((c) => c.args);
  assert.deepEqual(gteCalls, [["support", 15]], "gte predicate is applied");
});

test("loadCompiledLibraryPromptSection: empty workspace → empty string (Sol's system prompt stays byte-clean)", async () => {
  // deno-lint-ignore no-explicit-any
  const stub = makeStub({ playbooks: [], compiled_trees: [] }, []) as any;
  const section = await loadCompiledLibraryPromptSection(stub, WS);
  assert.equal(section, "");
});

test("loadCompiledLibraryPromptSection: one approved + one tree → composed string", async () => {
  const stub = makeStub({
    playbooks: [
      { id: "pb-1", workspace_id: WS, name: "Compiler seed A", description: "d", trigger_intents: ["intent_a"], trigger_patterns: [], source_tree_key: "a :: x", priority: 0, is_active: true, proposed_by: null },
    ],
    compiled_trees: [
      { id: "ct-1", workspace_id: WS, tree_key: "a :: x", problem: "a", action_types: ["x"], support: 33, intent_distribution: { intent_a: 30 }, reasoning: null, compiled_at: "2026-07-01" },
    ],
  }, []);
  // deno-lint-ignore no-explicit-any
  const section = await loadCompiledLibraryPromptSection(stub as any, WS);
  assert.match(section, /Approved compiler-derived playbooks/);
  assert.match(section, /tree_key=a :: x/);
  assert.match(section, /support=33/);
});
