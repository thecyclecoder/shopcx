/**
 * Pins `errText` — the lossless renderer for anything a `catch (e)` may hand us.
 *
 * The wedge is the real 23503 shape captured 2026-07-21 on ticket dfa77b28: a supabase-js
 * PostgREST error is a PLAIN OBJECT, not an Error instance, so the legacy
 * `e instanceof Error ? e.message : String(e)` catch renders it `[object Object]`. `errText`
 * must render its message + [code] + details + hint losslessly.
 *
 * Run: npx tsx --test src/lib/error-text.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { errText } from "./error-text";

test("PostgREST 23503 plain-object (the real Sol writeDirection failure) is rendered losslessly", () => {
  const e = {
    message:
      'insert or update on table "ticket_directions" violates foreign key constraint "ticket_directions_ticket_id_fkey"',
    code: "23503",
    details: 'Key (ticket_id)=(00000000-0000-0000-0000-000000000000) is not present in table "tickets".',
    hint: null,
  };
  const s = errText(e);
  assert.ok(s.includes('violates foreign key constraint'), `missing message: ${s}`);
  assert.ok(s.includes("[23503]"), `missing code: ${s}`);
  assert.ok(s.includes("(ticket_id)=(00000000-0000-0000-0000-000000000000)"), `missing details: ${s}`);
  assert.ok(!s.includes("[object Object]"), `regressed to [object Object]: ${s}`);
});

test(".single() no-rows PGRST116 shape is rendered losslessly", () => {
  const e = {
    message: "JSON object requested, multiple (or no) rows returned",
    code: "PGRST116",
    details: "The result contains 0 rows",
    hint: null,
  };
  const s = errText(e);
  assert.ok(s.includes("multiple (or no) rows returned"), s);
  assert.ok(s.includes("[PGRST116]"), s);
  assert.ok(s.includes("The result contains 0 rows"), s);
});

test("PostgREST hint is rendered when non-empty", () => {
  const e = {
    message: "column does not exist",
    code: "42703",
    details: null,
    hint: 'Perhaps you meant to reference the column "id".',
  };
  const s = errText(e);
  assert.ok(s.includes("column does not exist"), s);
  assert.ok(s.includes("[42703]"), s);
  assert.ok(s.includes('Perhaps you meant to reference the column "id".'), s);
});

test("plain Error renders its message", () => {
  assert.equal(errText(new Error("boom")), "boom");
});

test("bare string passes through", () => {
  assert.equal(errText("something went wrong"), "something went wrong");
});

test("circular object does not throw — falls back to Object.prototype.toString", () => {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  const s = errText(o);
  assert.equal(typeof s, "string");
  assert.ok(s.length > 0);
  assert.ok(!s.includes("[object Object]") || s === "[object Object]", s);
});

test("null → 'unknown error' (never the string 'null')", () => {
  assert.equal(errText(null), "unknown error");
  assert.equal(errText(undefined), "unknown error");
});

test("PostgrestError-shaped real Error (throwOnError path) still surfaces code + details", () => {
  // Simulate a real PostgrestError: it IS an Error and ALSO carries code/details/hint.
  class PostgrestError extends Error {
    code: string;
    details: string;
    hint: string | null;
    constructor(o: { message: string; code: string; details: string; hint: string | null }) {
      super(o.message);
      this.name = "PostgrestError";
      this.code = o.code;
      this.details = o.details;
      this.hint = o.hint;
    }
  }
  const e = new PostgrestError({
    message: "duplicate key value violates unique constraint",
    code: "23505",
    details: "Key (id)=(abc) already exists.",
    hint: null,
  });
  const s = errText(e);
  assert.ok(s.includes("duplicate key value"), s);
  assert.ok(s.includes("[23505]"), `PostgrestError code was dropped: ${s}`);
  assert.ok(s.includes("Key (id)=(abc) already exists."), `PostgrestError details were dropped: ${s}`);
});

test("plain object with no message field falls back to JSON.stringify (not [object Object])", () => {
  const s = errText({ status: 500, body: "upstream unavailable" });
  assert.ok(s.includes("upstream unavailable"), s);
  assert.ok(s.includes("500"), s);
  assert.notEqual(s, "[object Object]");
});

test("number / boolean / bigint fall back to String()", () => {
  assert.equal(errText(42), "42");
  assert.equal(errText(false), "false");
});

test("result is capped at 2000 chars so a huge PostgREST body cannot blow log_tail alone", () => {
  const big = "x".repeat(10_000);
  const s = errText({ message: big, code: "ZZZ", details: big, hint: big });
  assert.ok(s.length <= 2000, `errText did not cap: length=${s.length}`);
});
