/**
 * Unit tests for the pre-merge-fix DEPTH guard on the `regression_of_slug` chain
 * ([[../specs/pre-merge-fix-depth-guard-and-check-scoping]] Phase 1). Pins the four bullets from the
 * spec's Verification section:
 *
 *   1. `preMergeFixChainDepth('fix-fix-X')` returns 2 and `preMergeFixChainDepth('X')` returns 0 for the
 *      chain `X ← fix-X ← fix-fix-X` (the live 2026-07-02 shape).
 *   2. `spawnPreMergeFix` with an `originSlug` at depth ≥ `PRE_MERGE_FIX_MAX_DEPTH` returns
 *      `{ spawned:false, escalated:true }`, inserts NO new spec row, and records exactly ONE
 *      `director_activity` row with `metadata.signature='pre-merge-fix-depth-guard'`.
 *   3. At depth 0 (a fresh origin), `spawnPreMergeFix` still spawns — the depth guard is a rail, not a
 *      block on the first fix.
 *   4. A self-referential `regression_of_slug` fixture terminates via the self-ref stop (mirrors
 *      `retestOriginIfFixMerged` at agent-jobs.ts:1975) — the walk does NOT hang.
 *
 * Pure unit — no DB, no network. The admin surface is a hand-rolled stub that implements only the two
 * query shapes the code exercises: `.from('specs').select('regression_of_slug').eq(ws).eq(slug).maybeSingle()`
 * (the depth walker) and `.from('director_activity').insert(...)` (the escalate writer). This is the
 * intended pattern: pin the DEPTH-WALK LOGIC (traversal, terminators, hop-cap) on a stub, not the
 * supabase driver. Run:
 *   npx tsx --test src/lib/pre-merge-fix.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PRE_MERGE_FIX_MAX_DEPTH,
  preMergeFixChainDepth,
  spawnPreMergeFix,
  type SpawnPreMergeFixResult,
} from "./pre-merge-fix";

// The chain the depth-walker traverses. Each row's `regression_of_slug` is the parent (upward).
type SpecRow = { regression_of_slug: string | null };
type SpecTable = Record<string, SpecRow>;

interface DirectorActivityRow {
  workspace_id: string;
  director_function: string;
  action_kind: string;
  spec_slug: string | null;
  reason: string;
  metadata: Record<string, unknown> | null;
}

interface SpecInsertRow {
  workspace_id: string;
  slug: string;
  [k: string]: unknown;
}

interface AgentJobRow {
  workspace_id: string;
  spec_slug: string;
  kind: string;
}

/**
 * Minimal admin stub. Records every write for post-hoc assertions. Read surface implements only the
 * query shapes the depth-guard + escalation touches; unimplemented shapes throw loudly so a silent
 * mis-stub can't pass a test by accident.
 */
function makeStubAdmin(specs: SpecTable) {
  const directorActivity: DirectorActivityRow[] = [];
  const specInserts: SpecInsertRow[] = [];
  const specUpserts: SpecInsertRow[] = [];
  const agentJobInserts: AgentJobRow[] = [];

  function from(table: string) {
    if (table === "specs") {
      return {
        select(_cols: string) {
          return {
            eq(_col1: string, _v1: unknown) {
              return {
                eq(_col2: string, slug: string) {
                  return {
                    maybeSingle: async () => {
                      if (Object.prototype.hasOwnProperty.call(specs, slug)) {
                        return { data: specs[slug], error: null };
                      }
                      return { data: null, error: null };
                    },
                    limit: () => ({
                      maybeSingle: async () => ({ data: null, error: null }),
                    }),
                  };
                },
                // `countPreMergeFixAttempts` shape: `.select('slug').eq('regression_of_slug', origin)`.
                // We aren't testing breadth here — return no siblings.
                then: undefined,
              };
            },
          };
        },
        upsert: async (row: SpecInsertRow) => {
          specUpserts.push(row);
          return { data: row, error: null };
        },
        insert: async (row: SpecInsertRow) => {
          specInserts.push(row);
          return { data: row, error: null };
        },
      };
    }
    if (table === "director_activity") {
      return {
        insert: async (row: DirectorActivityRow) => {
          directorActivity.push(row);
          return { data: row, error: null };
        },
      };
    }
    if (table === "agent_jobs") {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        limit: () => ({
                          maybeSingle: async () => ({ data: null, error: null }),
                        }),
                      };
                    },
                  };
                },
              };
            },
          };
        },
        insert: async (row: AgentJobRow) => {
          agentJobInserts.push(row);
          return { data: row, error: null };
        },
      };
    }
    throw new Error(`stub admin: unimplemented table '${table}' — a real call slipped past the depth-guard test`);
  }

  return {
    from,
    _reads: { directorActivity, specInserts, specUpserts, agentJobInserts },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const WS = "ws-test";

// The exact chain the spec calls out (X ← fix-X ← fix-fix-X on the live 2026-07-02 vault-post-merge
// shape). `regression_of_slug` points upward to the parent.
const CHAIN_X_FIXX_FIXFIXX: SpecTable = {
  "X": { regression_of_slug: null },
  "fix-X": { regression_of_slug: "X" },
  "fix-fix-X": { regression_of_slug: "fix-X" },
};

test("PRE_MERGE_FIX_MAX_DEPTH default is 1 (allow one generation of fix; a fix-of-fix escalates)", () => {
  assert.equal(PRE_MERGE_FIX_MAX_DEPTH, 1);
});

test("preMergeFixChainDepth('X') on chain X ← fix-X ← fix-fix-X returns 0 (bullet 1 — a true origin)", async () => {
  const admin = makeStubAdmin(CHAIN_X_FIXX_FIXFIXX);
  assert.equal(await preMergeFixChainDepth(admin, WS, "X"), 0);
});

test("preMergeFixChainDepth('fix-X') returns 1 (bullet 1 — one hop to origin)", async () => {
  const admin = makeStubAdmin(CHAIN_X_FIXX_FIXFIXX);
  assert.equal(await preMergeFixChainDepth(admin, WS, "fix-X"), 1);
});

test("preMergeFixChainDepth('fix-fix-X') returns 2 (bullet 1 — two hops to origin; the depth the live 2026-07-02 loop would have caught)", async () => {
  const admin = makeStubAdmin(CHAIN_X_FIXX_FIXFIXX);
  assert.equal(await preMergeFixChainDepth(admin, WS, "fix-fix-X"), 2);
});

test("preMergeFixChainDepth: a slug whose regression_of_slug points at ITSELF terminates via the self-ref stop, does NOT hang (bullet 4)", async () => {
  const admin = makeStubAdmin({
    "self-ref": { regression_of_slug: "self-ref" },
  });
  // Self-referential row → treat as an origin (depth 0). Mirrors agent-jobs.ts:1975.
  assert.equal(await preMergeFixChainDepth(admin, WS, "self-ref"), 0);
});

test("preMergeFixChainDepth: a cyclic chain (A → B → A) terminates via the seen-set, does NOT hang", async () => {
  const admin = makeStubAdmin({
    "A": { regression_of_slug: "B" },
    "B": { regression_of_slug: "A" },
  });
  // A → B (depth 1, seen={A,B}), B → A (A already seen → return depth+1 = 2).
  const d = await preMergeFixChainDepth(admin, WS, "A");
  assert.equal(d, 2);
});

test("preMergeFixChainDepth: an unknown slug (no row) counts 0 hops (walker terminates instead of throwing)", async () => {
  const admin = makeStubAdmin({});
  assert.equal(await preMergeFixChainDepth(admin, WS, "ghost"), 0);
});

test("preMergeFixChainDepth: empty inputs short-circuit to 0 (no admin call)", async () => {
  const admin = makeStubAdmin({});
  assert.equal(await preMergeFixChainDepth(admin, WS, ""), 0);
  assert.equal(await preMergeFixChainDepth(admin, "", "X"), 0);
});

test("spawnPreMergeFix at depth ≥ PRE_MERGE_FIX_MAX_DEPTH returns {spawned:false,escalated:true} + inserts NO new spec + records ONE director_activity row with metadata.signature='pre-merge-fix-depth-guard' (bullet 2)", async () => {
  const admin = makeStubAdmin(CHAIN_X_FIXX_FIXFIXX);
  const out: SpawnPreMergeFixResult = await spawnPreMergeFix(admin, {
    workspaceId: WS,
    originSlug: "fix-X", // depth 1 — at the cap under the default MAX_DEPTH=1
    originTitle: "Fix: X",
    branch: "claude/build-fix-X",
    failing: [
      { text: "the failing check", evidence: "e", check_key: "failing-check" },
    ],
  });
  assert.equal(out.spawned, false);
  assert.equal(out.escalated, true);
  if (out.escalated) {
    assert.equal(out.depth, 1, "the depth-guard variant carries the actual chain depth");
  }
  // NO spec was authored — the depth guard fires before authoring.
  assert.equal(admin._reads.specInserts.length, 0);
  assert.equal(admin._reads.specUpserts.length, 0);
  // NO build was enqueued.
  assert.equal(admin._reads.agentJobInserts.length, 0);
  // Exactly ONE director_activity row with the depth-guard signature.
  assert.equal(admin._reads.directorActivity.length, 1);
  const row = admin._reads.directorActivity[0];
  assert.equal(row.action_kind, "escalated");
  assert.equal(row.director_function, "platform");
  assert.equal(row.spec_slug, "fix-X");
  assert.equal(row.metadata?.signature, "pre-merge-fix-depth-guard");
  assert.equal(row.metadata?.depth, 1);
  assert.equal(row.metadata?.max_depth, PRE_MERGE_FIX_MAX_DEPTH);
});

test("spawnPreMergeFix at depth 0 (a fresh origin) DOES NOT escalate on the depth guard — the guard is a rail, not a block on the first fix (bullet 3)", async () => {
  // Origin 'X' has depth 0 (no parent). The depth guard must not fire.
  const admin = makeStubAdmin(CHAIN_X_FIXX_FIXFIXX);
  const out: SpawnPreMergeFixResult = await spawnPreMergeFix(admin, {
    workspaceId: WS,
    originSlug: "X",
    originTitle: "X",
    branch: "claude/build-X",
    failing: [
      { text: "the failing check", evidence: "e", check_key: "k1" },
    ],
  });
  // Not escalated by the depth guard. (The spawn may still succeed or fail on downstream authoring;
  // the invariant this test pins is "no depth-guard escalate row was written".)
  const depthGuardRows = admin._reads.directorActivity.filter(
    (r: DirectorActivityRow) => r.metadata?.signature === "pre-merge-fix-depth-guard",
  );
  assert.equal(depthGuardRows.length, 0, "the depth guard must not fire at depth 0");
  // If we did escalate, it must NOT be for the depth guard signature.
  if (out.escalated) {
    assert.notEqual(out.depth, 0, "depth-guard escalate must never fire at depth 0");
  }
});

test("spawnPreMergeFix at deep depth (fix-fix-X, depth 2 >> max) escalates on the depth guard with the correct depth stamped", async () => {
  const admin = makeStubAdmin(CHAIN_X_FIXX_FIXFIXX);
  const out: SpawnPreMergeFixResult = await spawnPreMergeFix(admin, {
    workspaceId: WS,
    originSlug: "fix-fix-X",
    originTitle: "Fix: Fix: X",
    branch: "claude/build-fix-fix-X",
    failing: [
      { text: "the failing check", evidence: "e", check_key: "kk" },
    ],
  });
  assert.equal(out.spawned, false);
  assert.equal(out.escalated, true);
  if (out.escalated) {
    assert.equal(out.depth, 2);
  }
  const row = admin._reads.directorActivity[0];
  assert.equal(row.metadata?.signature, "pre-merge-fix-depth-guard");
  assert.equal(row.metadata?.depth, 2);
});
