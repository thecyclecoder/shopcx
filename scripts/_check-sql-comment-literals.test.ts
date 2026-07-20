/**
 * Named failing state: a migration's `COMMENT ON ... IS` payload is a `||` concatenation instead
 * of a bare string literal — a PARSE error (42601) that leaves the migration version permanently
 * unrecorded, so `applyMergedMigrations` re-runs the file and re-logs the error on every Control
 * Tower tick. The state `20261119120000_creative_skeletons_do_not_use.sql` was in for ~48
 * errors/day until the file itself was fixed.
 *
 * These tests pin the guard's predicate — literal→pass, concatenation→fail — plus the quote-aware
 * scanning that keeps a `;` or an `is` inside a literal from being misread as a boundary.
 *
 * Run:  npx tsx --test scripts/_check-sql-comment-literals.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { findExpressionComments, hasLiteralPayload, scanMigrations } from "./_check-sql-comment-literals";

const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

test("a bare string literal payload passes", () => {
  assert.ok(hasLiteralPayload("comment on column t.c is 'a plain comment'"));
});

test("a NULL payload passes (the documented way to clear a comment)", () => {
  assert.ok(hasLiteralPayload("comment on column t.c is null"));
});

test("a || concatenation payload fails — the exact 42601 shape", () => {
  assert.equal(hasLiteralPayload("comment on column t.c is 'first ' || 'second'"), false);
});

test("a literal containing '' escapes and newlines still passes", () => {
  assert.ok(hasLiteralPayload("comment on column t.c is 'it''s fine\nacross lines'"));
});

// The three payload forms below were run against Postgres directly (see the check's header):
// newline-separated literals parse, same-line adjacency and || are both 42601.
test("newline-separated literals pass — SQL-standard continuation, the house style", () => {
  assert.ok(hasLiteralPayload("comment on column t.c is\n  'first half '\n  'second half'"));
});

test("same-line adjacent literals fail — adjacency is not continuation without a newline", () => {
  assert.equal(hasLiteralPayload("comment on column t.c is 'first ' 'second'"), false);
});

test("a literal containing a semicolon is not split into two statements", () => {
  assert.deepEqual(findExpressionComments("comment on column t.c is 'a; b';", "x.sql"), []);
});

test("a || inside a literal is not a violation — only a top-level one is", () => {
  assert.deepEqual(findExpressionComments("comment on column t.c is 'pipes || inside';", "x.sql"), []);
});

test("an `is` inside a quoted identifier does not shadow the real payload keyword", () => {
  assert.ok(hasLiteralPayload(`comment on column t."is" is 'ok'`));
});

test("a violation reports its file and 1-indexed start line", () => {
  const sql = "-- header\nalter table t add column c int;\n\ncomment on column t.c is 'a ' || 'b';\n";
  const [v] = findExpressionComments(sql, "x.sql");
  assert.equal(v.file, "x.sql");
  assert.equal(v.line, 4);
});

test("non-COMMENT statements are ignored (|| is legal everywhere else)", () => {
  assert.deepEqual(findExpressionComments("update t set c = 'a' || 'b';", "x.sql"), []);
});

test("the live migrations tree is clean", () => {
  assert.deepEqual(scanMigrations(MIGRATIONS_DIR), []);
});
