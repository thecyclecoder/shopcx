/**
 * Unit tests for the Phase-1 UUID guard on the CX agent SDK's ticket id.
 *
 * Pins the exact behavior the spec verification requires: a truncated 8-hex
 * id (the '3cc11e10' incident) is rejected up front with a clean, self-
 * correcting message — never reaching Postgres to raise 22P02. A well-formed
 * UUID passes the guard so the existing `.maybeSingle()` path (row absent
 * ⇒ "ticket not found") can still deliver the intended clean signal.
 *
 *   npx tsx --test src/lib/cx-agent-sdk.ticket-uuid-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CX_TICKET_ID_UUID_RE,
  invalidCxTicketIdMessage,
  isValidCxTicketId,
} from "./cx-agent-sdk";

test("truncated 8-hex id ('3cc11e10' incident) → rejected as invalid", () => {
  assert.equal(isValidCxTicketId("3cc11e10"), false);
});

test("well-formed UUID → accepted (guard delegates to the existing not-found path)", () => {
  assert.equal(isValidCxTicketId("3cc11e10-1234-4abc-89de-0123456789ab"), true);
});

test("empty / null / non-string → rejected without throwing", () => {
  assert.equal(isValidCxTicketId(""), false);
  assert.equal(isValidCxTicketId(null), false);
  assert.equal(isValidCxTicketId(undefined), false);
  assert.equal(isValidCxTicketId(12345), false);
});

test("malformed-but-hex-ish shapes → rejected (no partial credit)", () => {
  // Missing hyphens, wrong section lengths, extra chars — all invalid.
  assert.equal(isValidCxTicketId("3cc11e1012344abc89de0123456789ab"), false);
  assert.equal(isValidCxTicketId("3cc11e10-1234-4abc-89de-0123456789ab-extra"), false);
  assert.equal(isValidCxTicketId("3cc11e10-1234-4abc-89de-0123456789ax"), false);
});

test("regex is anchored — no substring match", () => {
  assert.equal(
    CX_TICKET_ID_UUID_RE.test("prefix 3cc11e10-1234-4abc-89de-0123456789ab suffix"),
    false,
  );
});

test("invalidCxTicketIdMessage cites the exact id and tells the agent to pass the full UUID", () => {
  const msg = invalidCxTicketIdMessage("3cc11e10");
  assert.match(msg, /"3cc11e10"/);
  assert.match(msg, /not a valid ticket id/);
  assert.match(msg, /FULL ticket UUID/);
  assert.match(msg, /36 chars/);
  // Explicitly names the 22P02 failure mode we're preventing — an agent reading
  // the error should learn "don't send a shortened prefix," not just "retry."
  assert.match(msg, /shortened prefix/);
});
