/**
 * Regression tests for [[graph-retry]] app-owner-action-required classification —
 * [[../../../docs/brain/specs/meta-graph-classify-app-owner-action-required-data-use-check]]
 * Phase 1.
 *
 * The incident: today-sync's 5-min cron was logging Meta's canonical
 * "Data Use Checkup" HTTP 400 as a hard error every tick per active ad
 * account (~576/day per workspace), flooding the Control Tower error feed
 * with identical entries that carried no additional information beyond the
 * first occurrence. The only fix is a human logging into the Meta App
 * Dashboard, so this test pins the classification + no-retry + handler-fire
 * so the next occurrence is a single deduped CEO card, not a recurring error.
 *
 * Run:
 *   npx tsx --test src/lib/meta/graph-retry.app-owner-action-required.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAppOwnerActionRequired,
  graphError,
  graphFetchJson,
  isPermanentGraphError,
  isTransientGraphError,
  registerAppOwnerActionRequiredHandler,
  type AppOwnerActionRequiredContext,
  type GraphError,
} from "./graph-retry";

// Restore the (typically-null) handler after each test — the graph-retry module
// is a singleton so a leaked handler would bleed across tests.
function withHandler<T>(fn: (calls: AppOwnerActionRequiredContext[]) => Promise<T>): Promise<T> {
  const calls: AppOwnerActionRequiredContext[] = [];
  registerAppOwnerActionRequiredHandler((ctx) => {
    calls.push(ctx);
  });
  return fn(calls).finally(() => registerAppOwnerActionRequiredHandler(null));
}

// ── classifyAppOwnerActionRequired — the classifier ─────────────────────────

test("classifyAppOwnerActionRequired — 'Data Use Checkup' HTTP 400 message classifies true", () => {
  assert.equal(
    classifyAppOwnerActionRequired(400, {
      message: "Your app must complete the Data Use Checkup to continue accessing this API.",
    }),
    true,
  );
});

test("classifyAppOwnerActionRequired — 'API access disrupted' HTTP 400 error_user_msg classifies true", () => {
  assert.equal(
    classifyAppOwnerActionRequired(400, {
      error_user_msg: "API access disrupted — the app owner must clear this in the Meta App Dashboard.",
    }),
    true,
  );
});

test("classifyAppOwnerActionRequired — 'app is currently unavailable' user-facing title classifies true", () => {
  assert.equal(
    classifyAppOwnerActionRequired(400, {
      error_user_title: "The app is currently unavailable",
      error_user_msg: "Please contact the app developer.",
    }),
    true,
  );
});

test("classifyAppOwnerActionRequired — the wording on a 5xx wobble does NOT classify (transient wins)", () => {
  assert.equal(
    classifyAppOwnerActionRequired(503, { message: "data use checkup pending" }),
    false,
  );
});

test("classifyAppOwnerActionRequired — an unrelated 400 (invalid token, code 190) does NOT classify", () => {
  assert.equal(
    classifyAppOwnerActionRequired(400, { code: 190, message: "Invalid access token" }),
    false,
  );
});

// ── mutual-exclusion with permanent + transient ──────────────────────────────

test("Data Use Checkup 400 — app_owner_action_required AND NOT permanent AND NOT transient", () => {
  const err = { message: "Data Use Checkup required" };
  assert.equal(classifyAppOwnerActionRequired(400, err), true);
  assert.equal(isPermanentGraphError(400, err), false);
  assert.equal(isTransientGraphError(400, err), false);
});

// ── graphError tags metaClass on classification ──────────────────────────────

test("graphError — app-owner-action-required tags metaClass='app_owner_action_required'", () => {
  const err = graphError(400, {
    message: "Data Use Checkup required for this app.",
  });
  assert.equal(err.metaClass, "app_owner_action_required");
  assert.equal(err.httpStatus, 400);
});

test("graphError — app-owner-action-required is checked BEFORE permanent (deterministic ordering)", () => {
  // A message that would trip BOTH classifiers ('data use checkup' AND
  // 'no longer supported') should tag as app_owner_action_required — the
  // app-owner check runs first.
  const err = graphError(400, {
    message: "Data Use Checkup: your app is no longer supported until you complete it.",
  });
  assert.equal(err.metaClass, "app_owner_action_required");
});

// ── graphFetchJson — never retries this class + fires the handler ───────────

test("graphFetchJson — app-owner-action-required response is thrown on FIRST attempt, no retry, handler fires once", async () => {
  await withHandler(async (calls) => {
    let attempts = 0;
    const makeRequest = async (): Promise<Response> => {
      attempts += 1;
      return new Response(
        JSON.stringify({
          error: {
            message: "Data Use Checkup required — please complete it in the App Dashboard.",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    };

    await assert.rejects(
      () => graphFetchJson(makeRequest, "GET act_1234/insights"),
      (err: unknown) => {
        const e = err as GraphError;
        assert.equal(e.metaClass, "app_owner_action_required");
        assert.equal(e.httpStatus, 400);
        return true;
      },
    );

    // No retry — a human must clear the gate; retrying only burns quota.
    assert.equal(attempts, 1);
    // Handler fired exactly once with the calling label + classified error.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].label, "GET act_1234/insights");
    assert.equal(calls[0].status, 400);
    assert.equal(calls[0].error.metaClass, "app_owner_action_required");
  });
});

test("graphFetchJson — an app-owner-action-required handler that throws is swallowed; the original GraphError still surfaces", async () => {
  registerAppOwnerActionRequiredHandler(() => {
    throw new Error("handler_boom");
  });
  try {
    let attempts = 0;
    const makeRequest = async (): Promise<Response> => {
      attempts += 1;
      return new Response(
        JSON.stringify({ error: { message: "Data Use Checkup" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    };
    await assert.rejects(
      () => graphFetchJson(makeRequest, "GET label"),
      (err: unknown) => {
        const e = err as GraphError;
        assert.equal(e.metaClass, "app_owner_action_required");
        return true;
      },
    );
    assert.equal(attempts, 1);
  } finally {
    registerAppOwnerActionRequiredHandler(null);
  }
});

// ── today-sync isHandledTransient parity ────────────────────────────────────

test("today-sync's isHandledTransient predicate treats app_owner_action_required as warn (not error)", () => {
  // Mirrors the isHandledTransient branch in src/lib/inngest/today-sync.ts —
  // if this test drifts from that predicate the flood-prevention breaks.
  const tagged = graphError(400, {
    message: "Data Use Checkup required.",
  }) as { metaCode?: number; metaSubcode?: number; httpStatus?: number; metaClass?: string };
  const isHandledTransient =
    tagged?.metaCode === 1 ||
    tagged?.metaCode === 2 ||
    tagged?.metaSubcode === 1504018 ||
    (typeof tagged?.httpStatus === "number" && tagged.httpStatus >= 500) ||
    tagged?.metaClass === "app_owner_action_required";
  assert.equal(isHandledTransient, true);
});

test("today-sync's isHandledTransient predicate treats a plain fatal 400 as error (unchanged)", () => {
  const tagged = graphError(400, {
    code: 190,
    message: "Invalid OAuth access token.",
  }) as { metaCode?: number; metaSubcode?: number; httpStatus?: number; metaClass?: string };
  const isHandledTransient =
    tagged?.metaCode === 1 ||
    tagged?.metaCode === 2 ||
    tagged?.metaSubcode === 1504018 ||
    (typeof tagged?.httpStatus === "number" && tagged.httpStatus >= 500) ||
    tagged?.metaClass === "app_owner_action_required";
  assert.equal(isHandledTransient, false);
});
