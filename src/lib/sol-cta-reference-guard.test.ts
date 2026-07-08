/**
 * Unit tests for sol-cta-reference-guard — Phase 3 of
 * docs/brain/specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta.md.
 *
 * Pin the three Phase-3 verification bullets:
 *  (1) A reply containing 'click the button below' with no launched journey for the ticket is
 *      blocked and not sent (job needs_attention with a claim_tail reason).
 *  (2) The same reply text, when a journey WAS launched that turn, sends normally.
 *  (3) The guard does not false-positive on incidental phrases without a CTA reference.
 *
 * Pure regex detector + a small in-memory Supabase stub for the journey_sessions probe. Same
 * pattern as claim-guard.test.ts + sol-outcome-claim-guard.test.ts. Run:
 *   npx tsx --test src/lib/sol-cta-reference-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectCtaReference,
  hasLaunchedJourneyThisTurn,
  assertCtaBackedByLaunch,
} from "./sol-cta-reference-guard";

interface Row {
  [k: string]: unknown;
}

function makeAdmin(sessions: Row[], throwOnRead = false) {
  return {
    from(table: string) {
      if (table !== "journey_sessions") throw new Error(`unexpected table: ${table}`);
      const filters: Array<(r: Row) => boolean> = [];
      let limitN: number | null = null;
      const b = {
        select(_cols: string) {
          return b;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val);
          return b;
        },
        gte(col: string, val: unknown) {
          filters.push((r) => (r[col] as string) >= (val as string));
          return b;
        },
        limit(n: number) {
          limitN = n;
          return b;
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          if (throwOnRead) throw new Error("simulated probe error");
          let out = sessions.filter((r) => filters.every((f) => f(r)));
          if (limitN != null) out = out.slice(0, limitN);
          return Promise.resolve({ data: out, error: null }).then(resolve);
        },
      };
      return b;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const WS = "00000000-0000-0000-0000-0000000000ws";
const TID = "11111111-2222-3333-4444-555555555555";
const TURN_START = "2026-07-08T12:00:00Z";

// ── detectCtaReference: verification bullet 3's coverage (no false-positive) ──

test("detectCtaReference: 'click the button below' → hit", () => {
  const hit = detectCtaReference("Sure — click the button below to cancel.");
  assert.ok(hit);
  assert.match(hit!.matched_phrase, /click.*button.*below/i);
});

test("detectCtaReference: 'click here' → hit", () => {
  const hit = detectCtaReference("You can click here to update your address.");
  assert.ok(hit);
  assert.equal(hit!.pattern_name, "click_here");
});

test("detectCtaReference: 'use the link' → hit", () => {
  const hit = detectCtaReference("Please use the link I sent to reset your password.");
  assert.ok(hit);
  assert.equal(hit!.pattern_name, "use_the_link");
});

test("detectCtaReference: 'here is your link' → hit", () => {
  const hit = detectCtaReference("Here is your link to manage the subscription.");
  assert.ok(hit);
  assert.equal(hit!.pattern_name, "here_is_the_link");
});

test("detectCtaReference: 'tap the button' → hit", () => {
  const hit = detectCtaReference("Tap the button and follow the prompts.");
  assert.ok(hit);
  assert.equal(hit!.pattern_name, "tap_the_button");
});

test("detectCtaReference: incidental phrase 'that button on the fridge' → NO false-positive", () => {
  assert.equal(
    detectCtaReference("Thanks for the photo — that button on the fridge is our old logo!"),
    null,
    "guard must not trip on 'button' without a click/tap/below/here directive",
  );
});

test("detectCtaReference: incidental phrase 'the link between the two orders' → NO false-positive", () => {
  assert.equal(
    detectCtaReference("I can see the link between the two orders you mentioned."),
    null,
    "guard must not trip on 'link' without a click/use/follow directive",
  );
});

test("detectCtaReference: plain empathetic reply → NO false-positive", () => {
  assert.equal(
    detectCtaReference("I'm sorry to hear that — let me look into this for you."),
    null,
  );
});

test("detectCtaReference: empty / null message → null", () => {
  assert.equal(detectCtaReference(""), null);
  assert.equal(detectCtaReference(null), null);
  assert.equal(detectCtaReference(undefined), null);
});

// ── hasLaunchedJourneyThisTurn ──

test("hasLaunchedJourneyThisTurn: a session created after turn_started_at → true", async () => {
  const admin = makeAdmin([
    { id: "js-1", workspace_id: WS, ticket_id: TID, created_at: "2026-07-08T12:00:05Z" },
  ]);
  const launched = await hasLaunchedJourneyThisTurn({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    turn_started_at: TURN_START,
  });
  assert.equal(launched, true);
});

test("hasLaunchedJourneyThisTurn: only sessions BEFORE turn_started_at → false", async () => {
  const admin = makeAdmin([
    { id: "js-old", workspace_id: WS, ticket_id: TID, created_at: "2026-07-08T11:00:00Z" },
  ]);
  const launched = await hasLaunchedJourneyThisTurn({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    turn_started_at: TURN_START,
  });
  assert.equal(launched, false);
});

test("hasLaunchedJourneyThisTurn: cross-workspace session cannot back this ticket", async () => {
  const admin = makeAdmin([
    { id: "js-foreign", workspace_id: "00000000-0000-0000-0000-00000000ws2", ticket_id: TID, created_at: "2026-07-08T12:00:05Z" },
  ]);
  const launched = await hasLaunchedJourneyThisTurn({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    turn_started_at: TURN_START,
  });
  assert.equal(launched, false, "cross-workspace scope must be enforced (learning #7)");
});

test("hasLaunchedJourneyThisTurn: probe error → true (fail-open — a transient read cannot strand a legit reply)", async () => {
  const admin = makeAdmin([], true);
  const launched = await hasLaunchedJourneyThisTurn({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    turn_started_at: TURN_START,
  });
  assert.equal(launched, true);
});

// ── assertCtaBackedByLaunch: the three Phase-3 verification bullets ──

// (1) 'click the button below' with no launched journey → blocked with cta_tail reason.
test("assertCtaBackedByLaunch: CTA reference + NO journey launched this turn → blocked with cta_tail claim reason", async () => {
  const admin = makeAdmin([]);
  const verdict = await assertCtaBackedByLaunch({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    message: "Sure — click the button below to cancel your subscription.",
    turn_started_at: TURN_START,
  });
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.equal(verdict.hit.pattern_name, "click_the_button_below");
  assert.match(verdict.reason, /^blocked_unbacked_claim:cta_tail/);
  assert.match(verdict.reason, /click the button below/i);
});

// (2) Same reply text WITH a journey launched → OK, sends normally.
test("assertCtaBackedByLaunch: CTA reference + a journey WAS launched this turn → ok:true (send proceeds)", async () => {
  const admin = makeAdmin([
    { id: "js-cancel", workspace_id: WS, ticket_id: TID, created_at: "2026-07-08T12:00:05Z" },
  ]);
  const verdict = await assertCtaBackedByLaunch({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    message: "Sure — click the button below to cancel your subscription.",
    turn_started_at: TURN_START,
  });
  assert.equal(verdict.ok, true, "the launched journey backs the CTA reference");
});

// (3) Incidental phrase with no CTA reference → OK (no probe needed).
test("assertCtaBackedByLaunch: incidental phrase without a CTA reference → ok:true (no DB probe fires)", async () => {
  const admin = makeAdmin([]); // even without any sessions, the pure detector short-circuits
  const verdict = await assertCtaBackedByLaunch({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    message: "I'm sorry to hear that — I can see this is frustrating.",
    turn_started_at: TURN_START,
  });
  assert.equal(verdict.ok, true);
});

test("assertCtaBackedByLaunch: 'here is your link' + no launch → blocked", async () => {
  const admin = makeAdmin([]);
  const verdict = await assertCtaBackedByLaunch({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    message: "Here is your link to manage the subscription.",
    turn_started_at: TURN_START,
  });
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.match(verdict.reason, /^blocked_unbacked_claim:cta_tail/);
});

test("assertCtaBackedByLaunch: empty message → ok:true (nothing to send, nothing to guard)", async () => {
  const admin = makeAdmin([]);
  const verdict = await assertCtaBackedByLaunch({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    message: "",
    turn_started_at: TURN_START,
  });
  assert.equal(verdict.ok, true);
});
