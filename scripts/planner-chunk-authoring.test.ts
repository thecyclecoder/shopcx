/**
 * planner-chunk-authoring — unit tests pinning the exact invariants Phase 2
 * of docs/brain/specs/planner-authoring-survives-large-multi-spec-output.md
 * requires:
 *   (1) N>=6 approved specs chunk into ceil(N/K) batches, each ≤ K.
 *   (2) Chunks preserve order and cover the full set (no gaps, no dupes).
 *   (3) Inducing a failure after k specs are authored leaves those k
 *       persisted — modelled here by a caller loop where an authorer throws
 *       on chunk 2; the assert is that chunk 1's items remain in the
 *       accumulator.
 *
 *   npx tsx --test scripts/planner-chunk-authoring.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chunkForAuthoring, PLANNER_AUTHOR_BATCH_SIZE } from "./planner-chunk-authoring";

test("chunks N=6 approved into 3 batches of 2 with the default bounded size", () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  const batches = chunkForAuthoring(items);
  assert.equal(PLANNER_AUTHOR_BATCH_SIZE, 2, "the default K must stay small");
  assert.equal(batches.length, 3);
  for (const batch of batches) assert.ok(batch.length <= PLANNER_AUTHOR_BATCH_SIZE);
  assert.deepEqual(batches[0], ["a", "b"]);
  assert.deepEqual(batches[1], ["c", "d"]);
  assert.deepEqual(batches[2], ["e", "f"]);
});

test("preserves total set + order across chunks (flatten round-trips the input)", () => {
  const items = Array.from({ length: 17 }, (_, i) => i);
  for (const k of [1, 2, 3, 5, 8, 17, 32]) {
    const batches = chunkForAuthoring(items, k);
    assert.deepEqual(batches.flat(), items, `flatten must equal input for k=${k}`);
    for (const batch of batches) assert.ok(batch.length <= k, `every batch ≤ k for k=${k}`);
  }
});

test("handles the trailing partial batch (N=5, K=2 → [2,2,1])", () => {
  const batches = chunkForAuthoring(["a", "b", "c", "d", "e"], 2);
  assert.deepEqual(batches, [["a", "b"], ["c", "d"], ["e"]]);
});

test("empty input returns an empty batch list — the loop is a no-op", () => {
  assert.deepEqual(chunkForAuthoring<number>([], 2), []);
});

test("rejects a zero or negative batch size (caller bug)", () => {
  assert.throws(() => chunkForAuthoring([1, 2, 3], 0), /positive integer/);
  assert.throws(() => chunkForAuthoring([1, 2, 3], -1), /positive integer/);
  assert.throws(() => chunkForAuthoring([1, 2, 3], 1.5), /positive integer/);
});

test("inducing a failure on chunk 2 leaves chunk 1's items persisted in the accumulator", () => {
  // Simulate the runPlanJob loop shape: for each batch, call `author(batch)`
  // and record the successes. If author throws mid-loop, prior batches stay.
  const items = ["a", "b", "c", "d", "e", "f"];
  const batches = chunkForAuthoring(items, 2);
  const authored: string[] = [];
  const author = (batch: string[], idx: number) => {
    if (idx === 1) throw new Error("induced failure on chunk 2");
    for (const spec of batch) authored.push(spec);
  };
  let firstFailure: number | null = null;
  for (let i = 0; i < batches.length; i++) {
    try {
      author(batches[i], i);
    } catch {
      if (firstFailure === null) firstFailure = i;
      // The mandate: a chunk failure does NOT roll back prior chunks. It
      // records the batch failure and moves on so subsequent batches also
      // get a chance to land.
      continue;
    }
  }
  assert.equal(firstFailure, 1, "must remember which chunk failed");
  assert.deepEqual(authored, ["a", "b", "e", "f"], "chunk 1's items stay landed even when chunk 2 fails");
});
