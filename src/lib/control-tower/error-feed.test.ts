/**
 * Unit tests for the PURE error-feed noise filters (error-feed-monitoring + its noise-drop
 * specs). Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.test.ts
 *
 * Focus: isBareLifecycle must drop the bare Lambda lifecycle/proxy wrapper that opened
 * Control Tower signature `vercel:ebdf493a37c60c34` (error-feed-drop-bare-502-proxy-wrapper
 * spec). The original `$`-anchored proxy-summary regex never matched the real proxy line —
 * which carries trailing tokens (duration/region/bytes) after `status=NNN` — so `.every()`
 * failed and the wrapper was captured as a redundant open incident on a healthy, ticketed
 * Appstle 502 loop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isBareLifecycle } from "./error-feed";

// Regression fixture: the leaked vercel:ebdf493a37c60c34 blob — a bare Lambda lifecycle
// wrapper around the deliberate /api/portal Appstle 502 (669ms, 343MB/2048MB). The proxy
// summary carries trailing tokens after status=502, which the old `$`-anchored regex missed.
const BARE_502_BLOB = `START RequestId: 1d4f8c2a-9b3e-4a51-8f0c-2e6d7a9b1c33 Version: $LATEST
[POST] /api/portal?route=removeLineItem status=502 669ms
END RequestId: 1d4f8c2a-9b3e-4a51-8f0c-2e6d7a9b1c33
REPORT RequestId: 1d4f8c2a-9b3e-4a51-8f0c-2e6d7a9b1c33	Duration: 669.12 ms	Billed Duration: 670 ms	Memory Size: 2048 MB	Max Memory Used: 343 MB`;

test("isBareLifecycle drops the leaked vercel:ebdf493a37c60c34 bare 502 proxy wrapper", () => {
  assert.equal(isBareLifecycle(BARE_502_BLOB), true);
});

test("isBareLifecycle tolerates trailing tokens after status=NNN (no $ anchor)", () => {
  // duration / region / byte-count trailers Vercel appends to the proxy summary line.
  assert.equal(isBareLifecycle("[POST] /api/portal?route=removeLineItem status=502"), true);
  assert.equal(isBareLifecycle("[POST] /api/portal?route=removeLineItem status=502 669ms"), true);
  assert.equal(isBareLifecycle("[GET] /api/foo status=500 12ms iad1 1234b"), true);
});

test("isBareLifecycle drops a wrapper with split REPORT metric lines", () => {
  const blob = `START RequestId: abc Version: $LATEST
[GET] /api/portal status=500 5ms
END RequestId: abc
REPORT RequestId: abc
Duration: 5.01 ms
Billed Duration: 6 ms
Memory Size: 2048 MB
Max Memory Used: 120 MB
XRAY TraceId: 1-abc-def	SegmentId: 123	Sampled: true`;
  assert.equal(isBareLifecycle(blob), true);
});

test("isBareLifecycle KEEPS a lifecycle block that carries a real error body", () => {
  const blob = `START RequestId: abc Version: $LATEST
2026-06-24T00:00:00.000Z	abc	ERROR	Task timed out after 10.00 seconds
END RequestId: abc
REPORT RequestId: abc	Duration: 10000.00 ms`;
  assert.equal(isBareLifecycle(blob), false);
});

test("isBareLifecycle KEEPS an uncaught-exception stack (not bare)", () => {
  const blob = `START RequestId: abc Version: $LATEST
TypeError: Cannot read properties of undefined (reading 'id')
    at handler (/var/task/route.js:42:11)
END RequestId: abc`;
  assert.equal(isBareLifecycle(blob), false);
});

test("isBareLifecycle returns false on empty / whitespace-only input", () => {
  assert.equal(isBareLifecycle(""), false);
  assert.equal(isBareLifecycle("   \n  \n"), false);
});
