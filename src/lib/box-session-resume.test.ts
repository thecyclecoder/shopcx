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
import {
  isMissingSessionError,
  shouldRetryFresh,
  runBoxTurnWithFreshFallback,
  pickNextSession,
  type FailoverEnvelope,
} from "./box-session-resume";

// A minimal RunResult stand-in matching what withAccountFailover hands the four lanes.
interface FakeRun {
  session: string | null;
  resultText: string;
  isError: boolean;
  raw: string;
}
const DEAD = "c4d80812-1234-4abc-9def-0123456789ab";
const FRESH = "f00dbeef-0000-4000-8000-abcdef012345";
const MISSING_RAW = `Error: No conversation found with session ID: ${DEAD}`;

function stubFailover<T>(
  perCall: Array<(pin: { sessionId?: string | null }, sid: string | null) => Promise<FailoverEnvelope<T>>>,
): {
  fn: (
    pin: { sessionId?: string | null; sessionConfigDir?: string | null },
    run: (cfg: string, sid: string | null) => Promise<T>,
  ) => Promise<FailoverEnvelope<T>>;
  calls: Array<{ pinSessionId: string | null; ranWithSid: string | null }>;
} {
  const calls: Array<{ pinSessionId: string | null; ranWithSid: string | null }> = [];
  let n = 0;
  const fn = async (
    pin: { sessionId?: string | null; sessionConfigDir?: string | null },
    run: (cfg: string, sid: string | null) => Promise<T>,
  ): Promise<FailoverEnvelope<T>> => {
    const pinSid = pin.sessionId ?? null;
    // Simulate what the real failover does: invoke the closure with the resolved sessionId.
    // (For a "start fresh" pin the real failover passes null; we mirror that here.)
    await run("fake-cfg", pinSid);
    calls.push({ pinSessionId: pinSid, ranWithSid: pinSid });
    const step = perCall[n] ?? perCall[perCall.length - 1];
    n++;
    return step(pin, pinSid);
  };
  return { fn, calls };
}

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

// ── runBoxTurnWithFreshFallback — the shared wrapper Phase 2 routes the four lanes through. ──

test("runBoxTurnWithFreshFallback: healthy resumed run → returns first result, no retry", async () => {
  const good: FakeRun = { session: DEAD, resultText: '{"reply":"ok"}', isError: false, raw: "…" };
  const { fn, calls } = stubFailover<FakeRun>([
    async () => ({ result: good, configDir: "cfgA", allCapped: false }),
  ]);
  let fallbackFired = false;
  const out = await runBoxTurnWithFreshFallback<FakeRun>({
    pin: { sessionId: DEAD },
    run: async (_cfg, sid) => ({ session: sid, resultText: "", isError: false, raw: "" }),
    failover: fn,
    onFreshFallback: () => { fallbackFired = true; },
  });
  assert.equal(out.freshRetried, false);
  assert.equal(fallbackFired, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pinSessionId, DEAD);
  assert.equal(out.result?.resultText, '{"reply":"ok"}');
});

test("runBoxTurnWithFreshFallback: resumed run errored with missing-session raw → retries FRESH once", async () => {
  const dead: FakeRun = { session: null, resultText: "", isError: true, raw: MISSING_RAW };
  const fresh: FakeRun = { session: FRESH, resultText: '{"reply":"hi from fresh"}', isError: false, raw: "…" };
  const { fn, calls } = stubFailover<FakeRun>([
    async () => ({ result: dead, configDir: "cfgA", allCapped: false }),
    async () => ({ result: fresh, configDir: "cfgB", allCapped: false }),
  ]);
  let fallbackFired = false;
  const out = await runBoxTurnWithFreshFallback<FakeRun>({
    pin: { sessionId: DEAD, sessionConfigDir: "cfgA" },
    run: async (_cfg, sid) => ({ session: sid, resultText: "", isError: false, raw: "" }),
    failover: fn,
    onFreshFallback: () => { fallbackFired = true; },
  });
  assert.equal(out.freshRetried, true);
  assert.equal(fallbackFired, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pinSessionId, DEAD, "first attempt pins the dead id");
  assert.equal(calls[1].pinSessionId, null, "retry pins sessionId=null (fresh)");
  assert.equal(out.result?.session, FRESH);
  assert.equal(out.configDir, "cfgB");
});

test("runBoxTurnWithFreshFallback: no prior session (fresh start) → NEVER retries even on missing-session raw", async () => {
  const errored: FakeRun = { session: null, resultText: "", isError: true, raw: MISSING_RAW };
  const { fn, calls } = stubFailover<FakeRun>([
    async () => ({ result: errored, configDir: "cfgA", allCapped: false }),
  ]);
  const out = await runBoxTurnWithFreshFallback<FakeRun>({
    pin: { sessionId: null },
    run: async () => ({ session: null, resultText: "", isError: false, raw: "" }),
    failover: fn,
  });
  assert.equal(out.freshRetried, false);
  assert.equal(calls.length, 1);
});

test("runBoxTurnWithFreshFallback: resumed run errored on a NON-missing-session cap → no retry", async () => {
  const capped: FakeRun = { session: DEAD, resultText: "", isError: true, raw: "Usage limit reached." };
  const { fn, calls } = stubFailover<FakeRun>([
    async () => ({ result: capped, configDir: "cfgA", allCapped: false }),
  ]);
  const out = await runBoxTurnWithFreshFallback<FakeRun>({
    pin: { sessionId: DEAD },
    run: async () => ({ session: null, resultText: "", isError: false, raw: "" }),
    failover: fn,
  });
  assert.equal(out.freshRetried, false);
  assert.equal(calls.length, 1);
});

test("runBoxTurnWithFreshFallback: all Max accounts capped (result:null) → bubbles up, no retry", async () => {
  const { fn, calls } = stubFailover<FakeRun>([
    async () => ({ result: null, configDir: null, allCapped: true }),
  ]);
  const out = await runBoxTurnWithFreshFallback<FakeRun>({
    pin: { sessionId: DEAD },
    run: async () => ({ session: null, resultText: "", isError: false, raw: "" }),
    failover: fn,
  });
  assert.equal(out.freshRetried, false);
  assert.equal(out.result, null);
  assert.equal(out.allCapped, true);
  assert.equal(calls.length, 1);
});

test("runBoxTurnWithFreshFallback: hasReply gate — errored run that still produced a reply → no retry", async () => {
  const errWithReply: FakeRun = { session: DEAD, resultText: '{"reply":"partial"}', isError: true, raw: MISSING_RAW };
  const { fn, calls } = stubFailover<FakeRun>([
    async () => ({ result: errWithReply, configDir: "cfgA", allCapped: false }),
  ]);
  const out = await runBoxTurnWithFreshFallback<FakeRun>({
    pin: { sessionId: DEAD },
    run: async () => ({ session: null, resultText: "", isError: false, raw: "" }),
    failover: fn,
    hasReply: (r) => /"reply"\s*:\s*"[^"]+"/.test(r.resultText),
  });
  assert.equal(out.freshRetried, false);
  assert.equal(calls.length, 1);
});

test("runBoxTurnWithFreshFallback: retry itself hits allCapped → surfaces allCapped, freshRetried:true", async () => {
  const dead: FakeRun = { session: null, resultText: "", isError: true, raw: MISSING_RAW };
  const { fn, calls } = stubFailover<FakeRun>([
    async () => ({ result: dead, configDir: "cfgA", allCapped: false }),
    async () => ({ result: null, configDir: null, allCapped: true }),
  ]);
  const out = await runBoxTurnWithFreshFallback<FakeRun>({
    pin: { sessionId: DEAD },
    run: async () => ({ session: null, resultText: "", isError: false, raw: "" }),
    failover: fn,
  });
  assert.equal(out.freshRetried, true);
  assert.equal(out.allCapped, true);
  assert.equal(out.result, null);
  assert.equal(calls.length, 2);
});

// ── pickNextSession — the "don't re-save a dead id" guard the caller applies to persist. ──

test("pickNextSession: new session id present → use it", () => {
  assert.equal(pickNextSession({ newSession: FRESH, priorSessionId: DEAD, raw: "…" }), FRESH);
});

test("pickNextSession: no new id + prior id healthy → keep prior", () => {
  assert.equal(pickNextSession({ newSession: null, priorSessionId: DEAD, raw: "…" }), DEAD);
});

test("pickNextSession: no new id + prior id dead per raw → NULL (never re-save the dead id)", () => {
  assert.equal(pickNextSession({ newSession: null, priorSessionId: DEAD, raw: MISSING_RAW }), null);
});

test("pickNextSession: no new id + no prior id → null", () => {
  assert.equal(pickNextSession({ newSession: null, priorSessionId: null, raw: "…" }), null);
});
