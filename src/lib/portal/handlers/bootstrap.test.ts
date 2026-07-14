/**
 * Focused unit tests for the withBootstrapTimeout helper — the soft-deadline
 * primitive that keeps /api/portal (bootstrap) from being held past Vercel's
 * 30s ceiling by a slow optional enrichment. See spec:
 *   .box/spec-portal-bootstrap-soft-deadline.md
 *
 * Run: npx tsx --test src/lib/portal/handlers/bootstrap.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  withBootstrapTimeout,
  PORTAL_BOOTSTRAP_OPTIONAL_TIMEOUT_MS,
} from "./bootstrap";

test("PORTAL_BOOTSTRAP_OPTIONAL_TIMEOUT_MS is well under Vercel's 30s ceiling", () => {
  assert.equal(typeof PORTAL_BOOTSTRAP_OPTIONAL_TIMEOUT_MS, "number");
  assert.ok(PORTAL_BOOTSTRAP_OPTIONAL_TIMEOUT_MS > 0);
  // Bootstrap has other work to do (core reads, JSON serialization). Leave
  // plenty of headroom under the 30s Lambda cap.
  assert.ok(PORTAL_BOOTSTRAP_OPTIONAL_TIMEOUT_MS <= 10_000);
});

test("withBootstrapTimeout resolves to the value when work finishes under the deadline", async () => {
  const value = await withBootstrapTimeout(
    Promise.resolve([{ id: "a" }, { id: "b" }]),
    [] as { id: string }[],
    100,
  );
  assert.deepEqual(value, [{ id: "a" }, { id: "b" }]);
});

test("withBootstrapTimeout resolves to the fallback when work exceeds the deadline", async () => {
  const started = Date.now();
  const slow = new Promise<number[]>((resolve) => setTimeout(() => resolve([1, 2, 3]), 200));
  const value = await withBootstrapTimeout(slow, [] as number[], 20);
  const elapsed = Date.now() - started;
  assert.deepEqual(value, []);
  // Must NOT wait for the slow work — the whole point of the helper.
  assert.ok(elapsed < 150, `withBootstrapTimeout waited ${elapsed}ms (expected < 150)`);
});

test("withBootstrapTimeout resolves to the fallback when work rejects", async () => {
  const value = await withBootstrapTimeout(
    Promise.reject(new Error("boom")),
    0,
    50,
  );
  assert.equal(value, 0);
});

test("withBootstrapTimeout does not double-resolve when work finishes just after timeout", async () => {
  let resolveWork!: (v: number) => void;
  const work = new Promise<number>((r) => {
    resolveWork = r;
  });
  const value = await withBootstrapTimeout(work, -1, 10);
  assert.equal(value, -1);
  // Now let the work finish — must not throw / clobber the already-resolved
  // outer promise. Awaiting the underlying work directly should still succeed.
  resolveWork(42);
  const trailing = await work;
  assert.equal(trailing, 42);
});
