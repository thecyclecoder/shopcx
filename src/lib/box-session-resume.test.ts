/**
 * Unit tests for the box-session-resume detector — pins the signature match that lets a resumed
 * box-chat turn (director-coach, dev-ask, roadmap-chat, ticket-improve) retry fresh once instead
 * of hard-wedging on a session id the account no longer has.
 *
 * Run:
 *   npx tsx --test src/lib/box-session-resume.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isMissingSessionError, shouldRetryFresh } from "./box-session-resume";

test("isMissingSessionError matches the real signature", () => {
  const raw = 'Error: No conversation found with session ID: c4d80812-1234-4abc-9def-0123456789ab';
  assert.equal(isMissingSessionError(raw), true);
});

test("isMissingSessionError matches when the signature is buried in a longer log tail", () => {
  const raw = [
    "[claude] resuming session c4d80812-…",
    "some earlier chatter",
    "Error: No conversation found with session ID: c4d80812-1234-4abc-9def-0123456789ab",
    "trailing noise",
  ].join("\n");
  assert.equal(isMissingSessionError(raw), true);
});

test("isMissingSessionError is case-insensitive on the CLI text", () => {
  const raw = "no conversation found with session id: 00000000-0000-0000-0000-000000000000";
  assert.equal(isMissingSessionError(raw), true);
});

test("isMissingSessionError does NOT match a capped-account wall", () => {
  const raw = "Usage limit reached for this account — try again after the reset window.";
  assert.equal(isMissingSessionError(raw), false);
});

test("isMissingSessionError does NOT match an ordinary parse failure", () => {
  const raw = "SyntaxError: Unexpected token in JSON at position 42";
  assert.equal(isMissingSessionError(raw), false);
});

test("isMissingSessionError does NOT match an ordinary isError with no missing-session line", () => {
  const raw = "Error: worktree add failed: fatal: '/tmp/foo' already exists.";
  assert.equal(isMissingSessionError(raw), false);
});

test("isMissingSessionError returns false on empty / non-string input", () => {
  assert.equal(isMissingSessionError(""), false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(isMissingSessionError(null as any), false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(isMissingSessionError(undefined as any), false);
});

test("shouldRetryFresh: resumed run errored empty with the missing-session signature → true", () => {
  const ok = shouldRetryFresh({
    sessionId: "c4d80812-1234-4abc-9def-0123456789ab",
    isError: true,
    reply: "",
    raw: "Error: No conversation found with session ID: c4d80812-1234-4abc-9def-0123456789ab",
  });
  assert.equal(ok, true);
});

test("shouldRetryFresh: no prior sessionId (fresh start already) → false", () => {
  const ok = shouldRetryFresh({
    sessionId: null,
    isError: true,
    reply: "",
    raw: "Error: No conversation found with session ID: c4d80812-1234-4abc-9def-0123456789ab",
  });
  assert.equal(ok, false);
});

test("shouldRetryFresh: a healthy resumed run (has reply) → false", () => {
  const ok = shouldRetryFresh({
    sessionId: "c4d80812-1234-4abc-9def-0123456789ab",
    isError: false,
    reply: "ok done",
    raw: "…normal turn output…",
  });
  assert.equal(ok, false);
});

test("shouldRetryFresh: errored but not the missing-session signature → false", () => {
  const ok = shouldRetryFresh({
    sessionId: "c4d80812-1234-4abc-9def-0123456789ab",
    isError: true,
    reply: "",
    raw: "Usage limit reached — capped.",
  });
  assert.equal(ok, false);
});
