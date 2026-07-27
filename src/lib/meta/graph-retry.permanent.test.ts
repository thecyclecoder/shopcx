/**
 * Regression tests for [[graph-retry]] permanent / api-removed classification —
 * [[../../../docs/brain/specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]]
 * Phase 2.
 *
 * The incident: Meta removed Advantage+ Shopping Campaign creation (Graph
 * code `100` subcode `2490568`, "ASC campaigns no longer supported"). The
 * cold-scaler minting function had zero live callers so the breakage sat
 * undetected — a whole autonomous capability went to zero silently. This test
 * pins the classification + no-retry + handler-fire so the next occurrence is
 * a loud signal, not an archaeology exercise.
 *
 * Run:
 *   npx tsx --test src/lib/meta/graph-retry.permanent.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  graphError,
  graphFetchJson,
  isPermanentGraphError,
  isTransientGraphError,
  registerPermanentGraphErrorHandler,
  type GraphError,
  type PermanentGraphErrorContext,
} from "./graph-retry";
import { deadVerbCapabilitySignature } from "./dead-verb-escalation";

// Restore the (typically-null) handler after each test — the graph-retry module
// is a singleton so a leaked handler would bleed across tests.
function withHandler<T>(fn: (calls: PermanentGraphErrorContext[]) => Promise<T>): Promise<T> {
  const calls: PermanentGraphErrorContext[] = [];
  registerPermanentGraphErrorHandler((ctx) => {
    calls.push(ctx);
  });
  return fn(calls).finally(() => registerPermanentGraphErrorHandler(null));
}

// ── isPermanentGraphError — the classifier ───────────────────────────────────

test("isPermanentGraphError — ASC removal seed signature (code 100 subcode 2490568) classifies permanent", () => {
  assert.equal(
    isPermanentGraphError(400, { code: 100, error_subcode: 2490568, message: "ASC campaigns no longer supported" }),
    true,
  );
});

test("isPermanentGraphError — code 100 without the ASC subcode does NOT classify permanent on its own (permission-shape false positives)", () => {
  assert.equal(isPermanentGraphError(400, { code: 100, error_subcode: 33, message: "does not exist" }), false);
});

test("isPermanentGraphError — 'no longer supported' message on HTTP 400 classifies permanent even without the exact subcode", () => {
  assert.equal(
    isPermanentGraphError(400, {
      code: 100,
      error_subcode: 999999,
      message: "This surface is no longer supported.",
    }),
    true,
  );
});

test("isPermanentGraphError — 'deprecated' message on HTTP 400 classifies permanent", () => {
  assert.equal(
    isPermanentGraphError(400, {
      message: "The v18 endpoint is deprecated; use the graph campaigns primitive.",
    }),
    true,
  );
});

test("isPermanentGraphError — 'not supported with v21' message on HTTP 400 classifies permanent", () => {
  assert.equal(
    isPermanentGraphError(400, {
      message: "This request shape is not supported with v21.",
    }),
    true,
  );
});

test("isPermanentGraphError — a 5xx wobble is NEVER permanent (transient wins — retrying makes sense)", () => {
  assert.equal(isPermanentGraphError(503, { message: "no longer supported" }), false);
});

test("isPermanentGraphError — ordinary fatal (invalid token, code 190) does NOT classify permanent", () => {
  assert.equal(isPermanentGraphError(400, { code: 190, message: "Invalid access token" }), false);
});

test("isPermanentGraphError — transient (code 2 Service temporarily unavailable) does NOT classify permanent", () => {
  assert.equal(isPermanentGraphError(400, { code: 2, message: "Service temporarily unavailable" }), false);
});

test("isPermanentGraphError — user-facing title/message hits the message-shape branch", () => {
  assert.equal(
    isPermanentGraphError(400, {
      error_user_title: "Endpoint removed",
      error_user_msg: "This endpoint has been deprecated as of Marketing API v18.",
    }),
    true,
  );
});

// ── isTransient / isPermanent — mutually exclusive on the ASC signature ──────

test("The ASC-removal signature is permanent AND NOT transient — retry must never fire on it", () => {
  const err = { code: 100, error_subcode: 2490568, message: "ASC campaigns no longer supported" };
  assert.equal(isPermanentGraphError(400, err), true);
  assert.equal(isTransientGraphError(400, err), false);
});

// ── graphError tags the throw with metaClass on permanent classification ─────

test("graphError — permanent classification tags metaClass='permanent_api_removed' on the thrown Error", () => {
  const err = graphError(400, {
    code: 100,
    error_subcode: 2490568,
    message: "ASC campaigns no longer supported",
  });
  assert.equal(err.metaClass, "permanent_api_removed");
  assert.equal(err.metaCode, 100);
  assert.equal(err.metaSubcode, 2490568);
  assert.equal(err.httpStatus, 400);
});

test("graphError — ordinary fatal (code 190 token) has NO metaClass tag", () => {
  const err = graphError(400, { code: 190, message: "Invalid access token" });
  assert.equal(err.metaClass, undefined);
});

// ── graphFetchJson — never retries a permanent error + fires the handler ─────

test("graphFetchJson — permanent-class response is thrown on the FIRST attempt, no retry, handler fires once", async () => {
  await withHandler(async (calls) => {
    let attempts = 0;
    const makeRequest = async (): Promise<Response> => {
      attempts += 1;
      return new Response(
        JSON.stringify({
          error: {
            code: 100,
            error_subcode: 2490568,
            message: "ASC campaigns no longer supported",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    };

    await assert.rejects(
      () => graphFetchJson(makeRequest, "POST act_9999/campaigns"),
      (err: unknown) => {
        const e = err as GraphError;
        assert.equal(e.metaClass, "permanent_api_removed");
        assert.equal(e.metaCode, 100);
        assert.equal(e.metaSubcode, 2490568);
        return true;
      },
    );

    // No retry — a removed endpoint won't come back on backoff.
    assert.equal(attempts, 1);
    // Handler fired exactly once with the calling label + classified error.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].label, "POST act_9999/campaigns");
    assert.equal(calls[0].status, 400);
    assert.equal(calls[0].error.metaClass, "permanent_api_removed");
  });
});

test("graphFetchJson — a permanent-class handler that throws is swallowed; the original GraphError still surfaces", async () => {
  registerPermanentGraphErrorHandler(() => {
    throw new Error("handler_boom");
  });
  try {
    let attempts = 0;
    const makeRequest = async (): Promise<Response> => {
      attempts += 1;
      return new Response(
        JSON.stringify({
          error: { code: 100, error_subcode: 2490568, message: "ASC campaigns no longer supported" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    };
    await assert.rejects(
      () => graphFetchJson(makeRequest, "POST label"),
      (err: unknown) => {
        const e = err as GraphError;
        assert.equal(e.metaClass, "permanent_api_removed");
        return true;
      },
    );
    assert.equal(attempts, 1);
  } finally {
    registerPermanentGraphErrorHandler(null);
  }
});

test("graphFetchJson — a transient (code 2) response still retries and eventually succeeds (no regression to the transient path)", async () => {
  await withHandler(async (calls) => {
    let attempts = 0;
    const makeRequest = async (): Promise<Response> => {
      attempts += 1;
      if (attempts < 2) {
        return new Response(
          JSON.stringify({ error: { code: 2, message: "Service temporarily unavailable" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const j = await graphFetchJson(makeRequest, "GET recovery");
    assert.deepEqual(j, { data: [] });
    assert.equal(attempts, 2);
    assert.equal(calls.length, 0);
  });
});

// ── deadVerbCapabilitySignature — dedupe-key input ──────────────────────────

test("deadVerbCapabilitySignature — code + subcode collapse to meta_<code>_<subcode>", () => {
  const err = graphError(400, { code: 100, error_subcode: 2490568, message: "ASC removed" });
  assert.equal(deadVerbCapabilitySignature(err, "POST act/campaigns"), "meta_100_2490568");
});

test("deadVerbCapabilitySignature — code without subcode collapses to meta_<code>", () => {
  const err = graphError(400, { code: 100, message: "no longer supported" });
  assert.equal(deadVerbCapabilitySignature(err, "POST act/campaigns"), "meta_100");
});

test("deadVerbCapabilitySignature — no code falls back to label", () => {
  const err = graphError(400, { message: "no longer supported" });
  assert.equal(deadVerbCapabilitySignature(err, "POST act/campaigns"), "label:POST act/campaigns");
});
