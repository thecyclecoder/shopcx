/**
 * Unit tests for `getOrCreateAllCustomersAudience` +
 * `addUsersToCustomAudience` + normalization/hashing helpers
 * — bianca-full-order-history-customer-list-exclusion-audience Phase 1.
 *
 * Run:  npx tsx --test src/lib/meta-ads.customers-audience.test.ts
 *
 * Non-destructive: stubs `globalThis.fetch` so `graphFetchJson` never hits Meta.
 * Pins:
 *   - getOrCreateAllCustomersAudience is idempotent by exact name (a second
 *     call whose name is already present returns the existing id — NO POST).
 *   - A first call POSTs subtype=CUSTOMER_LIST +
 *     customer_file_source=USER_PROVIDED_ONLY and no rule.
 *   - addUsersToCustomAudience emits SHA256 hex (never plaintext), with
 *     normalized email (lowercase-trim) + phone (E.164 digits) inputs, and
 *     chunks payloads at ≤10k rows per POST (a >10k payload becomes two POSTs).
 *   - Rows with empty email AND empty phone are dropped.
 *   - A known email + phone hash to the expected SHA256 after normalization.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  META_CUSTOMAUDIENCE_USERS_CHUNK,
  addUsersToCustomAudience,
  getOrCreateAllCustomersAudience,
  normalizeEmailForHash,
  normalizePhoneForHash,
} from "./meta-ads";

interface Call { url: string; method: string; body: URLSearchParams }

function stubFetch(handler: (call: Call) => { status?: number; json: Record<string, unknown> }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method || "GET";
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    const call = { url, method, body };
    calls.push(call);
    const { status, json } = handler(call);
    return new Response(JSON.stringify(json), {
      status: status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

const ALL_CUSTOMERS_NAME = "MB — All customers (all sources) — hashed";

test("normalizeEmailForHash: lowercases + trims; empty → null", () => {
  assert.equal(normalizeEmailForHash("  Alice@Example.com  "), "alice@example.com");
  assert.equal(normalizeEmailForHash(""), null);
  assert.equal(normalizeEmailForHash("   "), null);
  assert.equal(normalizeEmailForHash(null), null);
  assert.equal(normalizeEmailForHash(undefined), null);
});

test("normalizePhoneForHash: strips non-digits, US 10-digit ⇒ 1-prefixed, keeps country codes", () => {
  assert.equal(normalizePhoneForHash("(415) 555-1234"), "14155551234");
  assert.equal(normalizePhoneForHash("+1 415 555 1234"), "14155551234");
  assert.equal(normalizePhoneForHash("+44 20 7946 0958"), "442079460958");
  assert.equal(normalizePhoneForHash(""), null);
  assert.equal(normalizePhoneForHash(null), null);
});

test("getOrCreateAllCustomersAudience — idempotent by exact name (no POST when it already exists)", async () => {
  const stub = stubFetch(() => ({
    json: {
      data: [
        { id: "aud-existing-1", name: ALL_CUSTOMERS_NAME, subtype: "CUSTOMER_LIST" },
      ],
    },
  }));
  try {
    const id = await getOrCreateAllCustomersAudience("token", "9999");
    assert.equal(id, "aud-existing-1");
    // Only the GET list call — no POST.
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].method, "GET");
    assert.ok(stub.calls[0].url.includes("/act_9999/customaudiences"));
  } finally {
    stub.restore();
  }
});

test("getOrCreateAllCustomersAudience — creates a CUSTOMER_LIST audience with USER_PROVIDED_ONLY when absent", async () => {
  const stub = stubFetch((call) => {
    if (call.method === "GET") return { json: { data: [] } };
    return { json: { id: "aud-created-1" } };
  });
  try {
    const id = await getOrCreateAllCustomersAudience("token", "act_9999");
    assert.equal(id, "aud-created-1");
    assert.equal(stub.calls.length, 2);
    const post = stub.calls[1];
    assert.equal(post.method, "POST");
    assert.ok(post.url.includes("/act_9999/customaudiences"));
    assert.equal(post.body.get("name"), ALL_CUSTOMERS_NAME);
    assert.equal(post.body.get("subtype"), "CUSTOMER_LIST");
    assert.equal(post.body.get("customer_file_source"), "USER_PROVIDED_ONLY");
    // No rule — CUSTOMER_LIST is populated via /users, not via a rule.
    assert.equal(post.body.get("rule"), null);
    // No pixel_id — that field is WEBSITE-only.
    assert.equal(post.body.get("pixel_id"), null);
  } finally {
    stub.restore();
  }
});

test("addUsersToCustomAudience — SHA256 hex only, schema, chunk boundary respected", async () => {
  const stub = stubFetch(() => ({ json: { audience_id: "aud-1", num_received: 1 } }));
  try {
    await addUsersToCustomAudience("token", "aud-1", [
      { email: "  Alice@Example.com  ", phone: "(415) 555-1234" },
    ]);
    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.method, "POST");
    assert.ok(call.url.endsWith("/aud-1/users"));
    const payload = JSON.parse(call.body.get("payload") || "{}");
    assert.deepEqual(payload.schema, ["EMAIL_SHA256", "PHONE_SHA256"]);
    assert.equal(payload.data.length, 1);
    const [emailHex, phoneHex] = payload.data[0];
    // SHA256 hex is 64 lowercase hex chars.
    assert.match(emailHex, /^[0-9a-f]{64}$/);
    assert.match(phoneHex, /^[0-9a-f]{64}$/);
    // Plaintext email/phone NEVER appear in the outbound body.
    const bodyString = call.body.toString();
    assert.ok(!bodyString.toLowerCase().includes("alice@example.com"));
    assert.ok(!bodyString.includes("4155551234"));
  } finally {
    stub.restore();
  }
});

test("addUsersToCustomAudience — a known input hashes to the expected SHA256 after normalization", async () => {
  const captured: string[][] = [];
  const stub = stubFetch((call) => {
    if (call.method === "POST") {
      const payload = JSON.parse(call.body.get("payload") || "{}");
      for (const row of payload.data) captured.push(row);
    }
    return { json: { audience_id: "aud-1", num_received: 0 } };
  });
  try {
    // The MessyMixed-case email + punctuated phone should normalize before hashing.
    await addUsersToCustomAudience("token", "aud-1", [
      { email: "USER@EXAMPLE.COM", phone: "+1 (415) 555-1234" },
    ]);
    // Known SHA256("user@example.com") — the canonical pinned vector.
    const expectedEmail = "b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514";
    assert.equal(captured.length, 1);
    assert.equal(captured[0][0], expectedEmail);
    // For the phone, re-hash the normalized digits in-process and assert the
    // uploader emitted the same bytes — this pins "phone is normalized to
    // E.164 digits, then SHA256-hex'd" without brittling on a memorized vector.
    const { subtle } = crypto;
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode("14155551234"));
    const reHex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.equal(captured[0][1], reHex);
  } finally {
    stub.restore();
  }
});

test("addUsersToCustomAudience — >10k rows split across multiple POSTs", async () => {
  const chunks: number[] = [];
  const stub = stubFetch((call) => {
    if (call.method === "POST") {
      const payload = JSON.parse(call.body.get("payload") || "{}");
      chunks.push(payload.data.length);
    }
    return { json: { audience_id: "aud-1", num_received: 0 } };
  });
  try {
    const rows = Array.from({ length: META_CUSTOMAUDIENCE_USERS_CHUNK + 5 }, (_, i) => ({
      email: `u${i}@example.com`,
      phone: null,
    }));
    const results = await addUsersToCustomAudience("token", "aud-1", rows);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], META_CUSTOMAUDIENCE_USERS_CHUNK);
    assert.equal(chunks[1], 5);
    assert.equal(results.length, 2);
  } finally {
    stub.restore();
  }
});

test("addUsersToCustomAudience — rows with empty email AND phone are dropped", async () => {
  const stub = stubFetch(() => ({ json: { audience_id: "aud-1", num_received: 0 } }));
  try {
    const results = await addUsersToCustomAudience("token", "aud-1", [
      { email: null, phone: null },
      { email: "", phone: "" },
    ]);
    // Nothing to send → zero POSTs.
    assert.equal(stub.calls.length, 0);
    assert.deepEqual(results, []);
  } finally {
    stub.restore();
  }
});
