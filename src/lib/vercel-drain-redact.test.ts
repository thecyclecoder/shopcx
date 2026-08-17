/**
 * Named failing state (security review of replace-log-drain-with-in-process-onrequesterror,
 * follow-up review of redact-vercel-drain-diagnostics): the two Vercel drain ops scripts
 * printed the raw Vercel API response body (`JSON.stringify(before)`) and the raw delivery
 * endpoint — so a drain configured with a shared secret in a query param, userinfo,
 * fragment, OR PATH SEGMENT leaks that secret into CI + worker logs. The follow-up review
 * closed the remaining path-segment gap: `redactedEndpoint` now emits only scheme + host
 * (with a fixed `/<path-redacted>` marker when the URL carried a non-root pathname) — the
 * pathname text itself is never printed. These tests pin the helper: no userinfo, no
 * search params, no hash, no pathname text, no top-level response fields other than the
 * allowlist.
 *
 * Run:  npx tsx --test src/lib/vercel-drain-redact.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  redactedEndpoint,
  summarizeDrain,
  endpointOf,
} from "./vercel-drain-redact";

const SECRET_QUERY = "sig=SHOULD_NOT_APPEAR";
const SECRET_HASH = "SHOULD_NOT_APPEAR_HASH";
const SECRET_USERINFO_USER = "leaky_user_SHOULD_NOT_APPEAR";
const SECRET_USERINFO_PASS = "leaky_pass_SHOULD_NOT_APPEAR";
const SECRET_HEADER = "X-Deep-Secret_SHOULD_NOT_APPEAR";
const SECRET_TOKEN = "sk_live_SHOULD_NOT_APPEAR";

test("redactedEndpoint strips userinfo, search, hash, and the pathname text", () => {
  const raw = `https://${SECRET_USERINFO_USER}:${SECRET_USERINFO_PASS}@logs.example.com/ingest?${SECRET_QUERY}#${SECRET_HASH}`;
  const display = redactedEndpoint(raw);
  assert.equal(display, "https://logs.example.com/<path-redacted>");
  assert.ok(!display.includes(SECRET_USERINFO_USER));
  assert.ok(!display.includes(SECRET_USERINFO_PASS));
  assert.ok(!display.includes("sig="));
  assert.ok(!display.includes(SECRET_HASH));
  assert.ok(!display.includes("ingest"));
});

test("redactedEndpoint returns a sentinel for unparseable input", () => {
  assert.equal(redactedEndpoint("not a url"), "<unparseable-endpoint>");
  assert.equal(redactedEndpoint(""), "<no-endpoint>");
  assert.equal(redactedEndpoint(null), "<no-endpoint>");
  assert.equal(redactedEndpoint(undefined), "<no-endpoint>");
});

test("redactedEndpoint preserves host+port and marks path as redacted; omits query even when no userinfo", () => {
  const display = redactedEndpoint(
    "https://logs.example.com:8443/ingest/batch?token=SECRET&keep=nothing",
  );
  assert.equal(display, "https://logs.example.com:8443/<path-redacted>");
  assert.ok(!display.includes("ingest"));
  assert.ok(!display.includes("batch"));
  assert.ok(!display.includes("token="));
  assert.ok(!display.includes("SECRET"));
});

test("redactedEndpoint omits the path marker when the URL has no non-root pathname", () => {
  assert.equal(redactedEndpoint("https://logs.example.com"), "https://logs.example.com");
  assert.equal(redactedEndpoint("https://logs.example.com/"), "https://logs.example.com");
  assert.equal(
    redactedEndpoint("https://logs.example.com:8443/"),
    "https://logs.example.com:8443",
  );
});

test("redactedEndpoint hides a secret embedded in a path segment (the pathname is unsafe display text)", () => {
  const PATH_SECRET = "sk_live_PATH_SEGMENT_SHOULD_NOT_APPEAR";
  const raw = `https://logs.example.com/ingest/${PATH_SECRET}/batch`;
  const display = redactedEndpoint(raw);
  assert.equal(display, "https://logs.example.com/<path-redacted>");
  assert.ok(
    !display.includes(PATH_SECRET),
    `redactedEndpoint leaked a path-segment secret: ${display}`,
  );
  assert.ok(!display.includes("ingest"));
  assert.ok(!display.includes("batch"));
});

test("summarizeDrain emits only allowlisted fields and never the raw response body", () => {
  const PATH_SECRET = "SHOULD_NOT_APPEAR_PATH_SEGMENT";
  const drain = {
    id: "drn_test123",
    name: "SHOPCX Control Tower",
    status: "disabled",
    delivery: {
      endpoint: `https://${SECRET_USERINFO_USER}:${SECRET_USERINFO_PASS}@shopcx.ai/api/webhooks/vercel-logs/${PATH_SECRET}?${SECRET_QUERY}#${SECRET_HASH}`,
      headers: { Authorization: `Bearer ${SECRET_TOKEN}`, "X-Secret": SECRET_HEADER },
      secret: SECRET_TOKEN,
    },
    createdAt: 1720000000000,
    ownerId: "team_secret_leak",
    // Fields future Vercel API versions might add — must not appear either.
    apiKey: SECRET_TOKEN,
    headers: { "X-Deep-Secret": SECRET_HEADER },
  } as unknown as Parameters<typeof summarizeDrain>[0];

  const summary = summarizeDrain(drain);

  assert.ok(summary.includes("id=drn_test123"));
  assert.ok(summary.includes('name="SHOPCX Control Tower"'));
  assert.ok(summary.includes("status=disabled"));
  assert.ok(summary.includes("endpoint=https://shopcx.ai/<path-redacted>"));

  for (const secret of [
    SECRET_USERINFO_USER,
    SECRET_USERINFO_PASS,
    SECRET_QUERY,
    "sig=",
    SECRET_HASH,
    SECRET_HEADER,
    SECRET_TOKEN,
    "Bearer",
    "Authorization",
    "team_secret_leak",
    "apiKey",
    "createdAt",
    PATH_SECRET,
    "api/webhooks/vercel-logs",
    "webhooks",
  ]) {
    assert.ok(
      !summary.includes(secret),
      `summary leaked secret-bearing token "${secret}": ${summary}`,
    );
  }
});

test("summarizeDrain falls back to disabled=true/false when status is absent", () => {
  const enabled = summarizeDrain({
    id: "drn_a",
    name: "n",
    disabled: false,
    delivery: { endpoint: "https://example.com/x" },
  });
  assert.ok(enabled.includes("status=enabled"));

  const disabled = summarizeDrain({
    id: "drn_b",
    name: "n",
    disabled: true,
    delivery: { endpoint: "https://example.com/x" },
  });
  assert.ok(disabled.includes("status=disabled"));
});

test("endpointOf prefers delivery.endpoint, falls back to endpoint then url", () => {
  assert.equal(
    endpointOf({ delivery: { endpoint: "https://a" }, endpoint: "https://b", url: "https://c" }),
    "https://a",
  );
  assert.equal(endpointOf({ endpoint: "https://b", url: "https://c" }), "https://b");
  assert.equal(endpointOf({ url: "https://c" }), "https://c");
  assert.equal(endpointOf({}), null);
});
