/**
 * Regression tests for the 2026-09-08 DEAD LINK outage.
 *
 *   npm run test:review-request-delivery-session
 *
 * What happened: `insertReviewRequestRow` REQUIRED a token (it threw without one)
 * and then never persisted it — no `journey_sessions` row, no column on
 * `review_requests`. Every minted `/review/{token}` link resolved to
 * `loadReviewSessionByToken` → `journey_sessions.token = …` → no row → 404
 * `session_not_found`. 455 asks and 341 nudges pointed at a dead page; the
 * response rate was 0.00%, not merely low.
 *
 * Why nothing caught it: the existing suite only exercised the PURE helpers
 * (token shape, channel choice, nudge suppression). Nothing asserted that the
 * token the customer receives can actually be resolved. The `/review/[token]`
 * page also returns 200 for a junk token — it is a client shell — so a smoke
 * test on the page URL passes while the API 404s.
 *
 * These tests pin the invariant that was missing: a review ask MUST leave behind
 * a session keyed on the SAME token that goes into the link.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { insertReviewRequestRow, createReviewJourneySession, REVIEW_REQUEST_TOKEN_TTL_MS } from "./review-request-delivery";

type Row = Record<string, unknown>;

/** Minimal Supabase stub: records inserts, serves the journey definition lookup. */
function stubAdmin(opts: { journeyId?: string | null } = {}) {
  const inserted: Record<string, Row[]> = {};
  const admin = {
    from(table: string) {
      const api: Record<string, unknown> = {
        insert(row: Row) {
          inserted[table] = [...(inserted[table] ?? []), row];
          return {
            select: () => ({
              single: async () => ({ data: { id: `${table}-id-1` }, error: null }),
            }),
          };
        },
        select() {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({
              data: opts.journeyId === null ? null : { id: opts.journeyId ?? "journey-1" },
              error: null,
            }),
          };
          return chain;
        },
      };
      return api;
    },
  } as unknown as Parameters<typeof insertReviewRequestRow>[0];
  return { admin, inserted };
}

const ASK = {
  workspaceId: "ws-1",
  customerId: "cust-1",
  productId: "prod-1",
  channel: "email" as const,
  angle: "post-order:fence-sitter",
  token: "abc123def456abc123def456",
};

test("an ask creates a journey_sessions row carrying the SAME token as the link", async () => {
  const { admin, inserted } = stubAdmin();
  await insertReviewRequestRow(admin, ASK);
  const sessions = inserted.journey_sessions ?? [];
  assert.equal(sessions.length, 1, "exactly one session per ask");
  assert.equal(sessions[0].token, ASK.token, "the session must be keyed on the token the customer receives");
});

test("the ladder row is JOINED to the session it resolves against", async () => {
  const { admin, inserted } = stubAdmin();
  await insertReviewRequestRow(admin, ASK);
  const reqs = inserted.review_requests ?? [];
  assert.equal(reqs.length, 1);
  assert.ok(reqs[0].journey_session_id, "review_requests.journey_session_id must be populated at send time");
});

test("the session carries workspace, customer and product — the loader reads authority from the row", async () => {
  const { admin, inserted } = stubAdmin();
  await insertReviewRequestRow(admin, ASK);
  const s = (inserted.journey_sessions ?? [])[0];
  assert.equal(s.workspace_id, ASK.workspaceId);
  assert.equal(s.customer_id, ASK.customerId);
  assert.equal(s.product_id, ASK.productId);
});

test("session status is never 'completed' — loadReviewSessionByToken refuses that", async () => {
  const { admin, inserted } = stubAdmin();
  await insertReviewRequestRow(admin, ASK);
  assert.notEqual((inserted.journey_sessions ?? [])[0].status, "completed");
});

test("the token outlives the 3-day nudge", () => {
  const threeDays = 3 * 24 * 60 * 60 * 1000;
  assert.ok(
    REVIEW_REQUEST_TOKEN_TTL_MS > threeDays,
    "a link that expires before its own nudge would resurrect the dead-link bug in slow motion",
  );
});

test("token_expires_at is set and in the future", async () => {
  const { admin, inserted } = stubAdmin();
  await insertReviewRequestRow(admin, ASK);
  const exp = (inserted.journey_sessions ?? [])[0].token_expires_at;
  assert.ok(typeof exp === "string", "expiry must be stamped");
  assert.ok(new Date(exp as string).getTime() > Date.now(), "a link must not ship pre-expired");
});

test("NO review_requests row is written when the session cannot be created", async () => {
  // Ordering guarantee: a row claiming outcome='sent' behind a 404 link is worse
  // than no row, so the session is minted FIRST and a failure aborts the ask.
  const { admin, inserted } = stubAdmin({ journeyId: null });
  await assert.rejects(() => insertReviewRequestRow(admin, ASK), /journey definition/i);
  assert.equal((inserted.review_requests ?? []).length, 0, "must not record an ask whose link cannot work");
});

test("createReviewJourneySession refuses a workspace with no product-review journey", async () => {
  const { admin } = stubAdmin({ journeyId: null });
  await assert.rejects(
    () => createReviewJourneySession(admin, {
      workspaceId: "ws-1", customerId: "cust-1", productId: "prod-1", token: ASK.token,
    }),
    /product-review/,
  );
});
