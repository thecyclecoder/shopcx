// Bounded-retry boundary for `fetchCreative` — a momentary AdLibrary 503 must
// no longer poison a competitor ad row via the scout's dedup key, but a bad
// url / bad credentials still fail on the first response so we don't mask them.
// The env key is set BEFORE the module is loaded (ADLIBRARY_API_KEY is captured
// at module load), which is why we import dynamically inside `before`.
import test, { before } from "node:test";
import assert from "node:assert/strict";

type AL = typeof import("./adlibrary");
let AL: AL;

before(async () => {
  process.env.ADLIBRARY_API_KEY = "test-key";
  AL = await import("./adlibrary");
});

function fakeOk(body = "ok", contentType = "image/jpeg"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}
function fakeErr(status: number): Response {
  return new Response(`err ${status}`, { status });
}

test("classifier: the transient AdLibrary creative status set is the vendor-outage set", () => {
  for (const s of [408, 429, 500, 502, 503, 504]) {
    assert.equal(AL.isTransientAdlibraryCreativeStatus(s), true, `${s} should be transient`);
    assert.equal(AL.TRANSIENT_ADLIBRARY_CREATIVE_STATUSES.has(s), true);
  }
  for (const s of [400, 401, 403, 404, 405, 410, 418, 501, 505]) {
    assert.equal(
      AL.isTransientAdlibraryCreativeStatus(s),
      false,
      `${s} should NOT be transient`,
    );
  }
});

test("recovers when a bounded number of transient 503s precede a 200", async () => {
  const queue: Response[] = [fakeErr(503), fakeErr(503), fakeOk("payload")];
  const calls: string[] = [];
  const sleeps: number[] = [];
  const out = await AL.fetchCreative("https://adlibrary.com/x", {
    fetchImpl: async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return queue.shift()!;
    },
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
    maxAttempts: 3,
    baseDelayMs: 10,
  });
  assert.equal(calls.length, 3);
  assert.equal(out.contentType, "image/jpeg");
  assert.equal(out.buffer.toString(), "payload");
  // Backoff MUST be bounded: two retries → two sleeps, growing but small.
  assert.deepEqual(sleeps, [10, 20]);
});

test("preserves adlibrary_creative_${status} shape after retries are exhausted", async () => {
  const queue: Response[] = [fakeErr(503), fakeErr(503), fakeErr(503)];
  const sleeps: number[] = [];
  await assert.rejects(
    AL.fetchCreative("https://adlibrary.com/x", {
      fetchImpl: async () => queue.shift()!,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
      baseDelayMs: 5,
    }),
    /^Error: adlibrary_creative_503$/,
  );
  // Final attempt is NOT followed by a sleep — sleeps == attempts - 1.
  assert.deepEqual(sleeps, [5, 10]);
});

test("non-transient 404 fails fast on the first response (no retry, no sleep)", async () => {
  let calls = 0;
  let sleepCalls = 0;
  await assert.rejects(
    AL.fetchCreative("https://adlibrary.com/x", {
      fetchImpl: async () => {
        calls++;
        return fakeErr(404);
      },
      sleepImpl: async () => {
        sleepCalls++;
      },
      maxAttempts: 3,
      baseDelayMs: 5,
    }),
    /^Error: adlibrary_creative_404$/,
  );
  assert.equal(calls, 1);
  assert.equal(sleepCalls, 0);
});

test("non-transient 403 (credentials) fails fast — retries would only hide the auth problem", async () => {
  let calls = 0;
  await assert.rejects(
    AL.fetchCreative("https://adlibrary.com/x", {
      fetchImpl: async () => {
        calls++;
        return fakeErr(403);
      },
      sleepImpl: async () => {
        /* unused */
      },
      maxAttempts: 3,
      baseDelayMs: 0,
    }),
    /^Error: adlibrary_creative_403$/,
  );
  assert.equal(calls, 1);
});
