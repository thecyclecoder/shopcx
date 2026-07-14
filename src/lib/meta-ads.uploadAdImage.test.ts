/**
 * Focused unit test for `uploadAdImage` — meta-adimage-multipart-retry Phase 1
 * verification. Proves the multipart /adimages upload retries a transient Meta
 * error via `graphFetchJson` and rebuilds a fresh FormData body on each attempt.
 *
 * Run:  npx tsx --test src/lib/meta-ads.uploadAdImage.test.ts
 *
 * Non-destructive: stubs `globalThis.fetch` so the retry wrapper never hits Meta.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { uploadAdImage } from "./meta-ads";

test("uploadAdImage — retries a transient Meta error then returns the hash", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; hasFormData: boolean }> = [];
  let attempt = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, hasFormData: init?.body instanceof FormData });
    attempt += 1;
    if (attempt === 1) {
      // Meta's transient "Service temporarily unavailable" — Graph code 2 on HTTP 400
      // (see graph-retry.ts). Classified as transient; graphFetchJson must retry.
      return new Response(
        JSON.stringify({ error: { code: 2, message: "Service temporarily unavailable" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ images: { "thumb.jpg": { hash: "abc123hash" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const hash = await uploadAdImage("token", "act_9999", Buffer.from([1, 2, 3, 4]), "thumb.jpg");
    assert.equal(hash, "abc123hash");
    assert.equal(calls.length, 2, "one retry after the transient failure");
    for (const c of calls) {
      assert.ok(c.url.endsWith("/act_9999/adimages"), `expected /adimages endpoint, got ${c.url}`);
      // Each attempt gets its own fresh FormData — a Blob-backed body can't be reused across fetches.
      assert.ok(c.hasFormData, "every attempt must send a multipart FormData body");
    }
  } finally {
    globalThis.fetch = original;
  }
});
