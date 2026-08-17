/**
 * Named failing state (security review of replace-log-drain-with-in-process-onrequesterror):
 * the two Vercel drain ops scripts printed the raw Vercel API response body
 * (`JSON.stringify(before)`) and the raw delivery endpoint — so a drain configured with a
 * shared secret in a query param, userinfo, or fragment leaks that secret into CI + worker
 * logs. These tests pin the helper: no userinfo, no search params, no hash, no top-level
 * response fields other than the allowlist.
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

test("redactedEndpoint strips userinfo, search, and hash", () => {
  const raw = `https://${SECRET_USERINFO_USER}:${SECRET_USERINFO_PASS}@logs.example.com/ingest?${SECRET_QUERY}#${SECRET_HASH}`;
  const display = redactedEndpoint(raw);
  assert.equal(display, "https://logs.example.com/ingest");
  assert.ok(!display.includes(SECRET_USERINFO_USER));
  assert.ok(!display.includes(SECRET_USERINFO_PASS));
  assert.ok(!display.includes("sig="));
  assert.ok(!display.includes(SECRET_HASH));
});

test("redactedEndpoint returns a sentinel for unparseable input", () => {
  assert.equal(redactedEndpoint("not a url"), "<unparseable-endpoint>");
  assert.equal(redactedEndpoint(""), "<no-endpoint>");
  assert.equal(redactedEndpoint(null), "<no-endpoint>");
  assert.equal(redactedEndpoint(undefined), "<no-endpoint>");
});

test("redactedEndpoint preserves host + path but omits query even when no userinfo", () => {
  const display = redactedEndpoint(
    "https://logs.example.com:8443/ingest/batch?token=SECRET&keep=nothing",
  );
  assert.equal(display, "https://logs.example.com:8443/ingest/batch");
});

test("summarizeDrain emits only allowlisted fields and never the raw response body", () => {
  const drain = {
    id: "drn_test123",
    name: "SHOPCX Control Tower",
    status: "disabled",
    delivery: {
      endpoint: `https://${SECRET_USERINFO_USER}:${SECRET_USERINFO_PASS}@shopcx.ai/api/webhooks/vercel-logs?${SECRET_QUERY}#${SECRET_HASH}`,
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
  assert.ok(summary.includes("endpoint=https://shopcx.ai/api/webhooks/vercel-logs"));

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
