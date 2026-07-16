/**
 * Unit tests for the qaCreativeViaBoxSession verdict shape — specifically the Phase-2 packagingFaithful
 * check (ad-creative-requires-real-packshot-never-invent-packaging).
 *
 * The vision compare itself is the model's job; what we can pin deterministically is the parser +
 * gating logic: (a) when the QC session returns `packagingFaithful:false`, the final verdict FAILS
 * and packagingFaithful survives on `checks`; (b) when no packshot is supplied (own-brand path) the
 * check is SKIPPED locally — even a model returning false is forced to true so a legitimate render
 * can't be false-failed on a missing reference.
 *
 * Run: npx tsx --test src/lib/ads/creative-qa.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { qaCreativeViaBoxSession } from "./creative-qa";

async function makeRedJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 30, b: 40 } } }).jpeg().toBuffer();
}

function verdictJson(overrides: Record<string, unknown>): string {
  const defaults = {
    pass: true,
    issues: [],
    checks: {
      headlineExact: true,
      textLegible: true,
      noBarePrice: true,
      noFabricatedPhotoCaption: true,
      transformationPhotorealistic: true,
      packagingFaithful: true,
      // Phase 2 of ad-creative-only-our-real-offer-discount-shown-never-a-competitors — default the
      // new field to true so pre-Phase-2 test call sites (which don't thread realOffer) stay green
      // via the local skip semantic.
      offerConsistent: true,
    },
  };
  const merged = { ...defaults, ...overrides, checks: { ...defaults.checks, ...((overrides.checks as Record<string, unknown> | undefined) ?? {}) } };
  // Derive top-level `pass` from checks unless the caller explicitly overrode it.
  if (!("pass" in overrides)) merged.pass = Object.values(merged.checks).every(Boolean);
  return JSON.stringify(merged);
}

test("qaCreativeViaBoxSession — no packshotUrl supplied → skip forces checks.packagingFaithful=true regardless of the model's answer", async () => {
  const buffer = await makeRedJpeg();
  // A cooperative session in the aggregate — the model returns pass:true and every other check true,
  // BUT wrongly emits packagingFaithful:false (perhaps hallucinating a "pack looks fake" verdict when
  // no reference was supplied). Our local override neutralizes that spurious signal.
  const dispatch = async (_prompt: string, allowedImagePath: string) => {
    assert.ok(!allowedImagePath.includes(","), "no comma when no packshot supplied — legacy single-path allowed env");
    return { resultText: verdictJson({ pass: true, checks: { packagingFaithful: false } }), isError: false };
  };
  const verdict = await qaCreativeViaBoxSession(
    { buffer, expectedCopy: { headline: "Hi", offer: "10% off", trust: "10k reviews" } },
    dispatch,
  );
  assert.equal(verdict.checks.packagingFaithful, true, "no packshot supplied → local skip forces the field to true, disregarding the model");
  assert.equal(verdict.pass, true, "verdict passes on skip — no legitimate render is false-failed on a missing reference");
});

test("qaCreativeViaBoxSession — a QC session that fails ONLY on packagingFaithful (with a packshot supplied and loaded) FAILS the whole verdict", async () => {
  // We need a fetchable packshot URL. Spin a tiny in-process fixture: serve a small red JPEG on a random
  // localhost port so loadReferencePackshot actually pulls it and packshotPath !== null in the box path.
  const { createServer } = await import("http");
  const packshot = await makeRedJpeg();
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(packshot.length) });
    res.end(packshot);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/pack.jpg`;
  try {
    const buffer = await makeRedJpeg();
    const dispatch = async (_prompt: string, allowedImagePath: string) => {
      // Must have received a comma-separated pair (render + packshot) so the QC gate would allow both.
      assert.ok(allowedImagePath.includes(","), "dispatcher receives comma-separated allowed paths when a packshot is threaded");
      const paths = allowedImagePath.split(",").map((s) => s.trim());
      assert.equal(paths.length, 2, "exactly the render + the reference packshot");
      return { resultText: verdictJson({ checks: { packagingFaithful: false } }), isError: false };
    };
    const verdict = await qaCreativeViaBoxSession(
      { buffer, expectedCopy: { headline: "Hi", offer: "10% off", trust: "10k reviews" }, packshotUrl: url },
      dispatch,
    );
    // The enforcement contract: packagingFaithful is now honored (the model said false, the packshot
    // was actually loaded), so the whole verdict fails.
    assert.equal(verdict.checks.packagingFaithful, false, "packagingFaithful mirrors the QC verdict when a reference was loaded");
    assert.equal(verdict.pass, false, "a single failing check fails the whole QC verdict");
    assert.ok(verdict.issues.length > 0, "the failure carries an explanatory issue");
    assert.ok(verdict.issues.some((i) => i.includes("packagingFaithful")), "the default issue string names packagingFaithful");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("qaCreativeViaBoxSession — all checks true INCLUDING packagingFaithful with a supplied+loaded packshot → verdict passes", async () => {
  const { createServer } = await import("http");
  const packshot = await makeRedJpeg();
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(packshot.length) });
    res.end(packshot);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/pack.jpg`;
  try {
    const buffer = await makeRedJpeg();
    const dispatch = async () => ({ resultText: verdictJson({}), isError: false });
    const verdict = await qaCreativeViaBoxSession(
      { buffer, expectedCopy: { headline: "Hi", offer: "10% off", trust: "10k reviews" }, packshotUrl: url },
      dispatch,
    );
    assert.equal(verdict.checks.packagingFaithful, true);
    assert.equal(verdict.pass, true);
    assert.deepEqual(verdict.issues, []);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("qaCreativeViaBoxSession — a packshot URL that fails to fetch is treated as SKIP (packagingFaithful=true) rather than a verdict failure", async () => {
  const buffer = await makeRedJpeg();
  // Point at a port nothing is listening on so the fetch errors out.
  const url = "http://127.0.0.1:1/never-listens.jpg";
  const dispatch = async (_prompt: string, allowedImagePath: string) => {
    // With no packshot loaded, the dispatcher receives only ONE path (no comma).
    assert.ok(!allowedImagePath.includes(","), "no comma when the packshot failed to load");
    // Even a cooperative session that emits packagingFaithful:false in the checks (a stale/echoed
    // signal after the reference didn't reach it) must not fail the render — Phase 1 already gated
    // the fabricate risk upstream.
    return { resultText: verdictJson({ pass: true, checks: { packagingFaithful: false } }), isError: false };
  };
  const verdict = await qaCreativeViaBoxSession(
    { buffer, expectedCopy: { headline: "Hi", offer: "10% off", trust: "10k reviews" }, packshotUrl: url },
    dispatch,
  );
  assert.equal(verdict.checks.packagingFaithful, true, "packshot fetch failure → skip, packagingFaithful stays true");
  assert.equal(verdict.pass, true, "verdict still passes — Phase 1 already gated the fabricate risk upstream");
});

// ── Phase 2: ad-creative-only-our-real-offer-discount-shown-never-a-competitors ─────────────────
// Fixture: the image's rendered discount doesn't match our real offer (e.g. a competitor's "50%
// OFF" leaked into the headline while our real offer is "Up to 34% off + free shipping") — QA now
// rejects that pair via `offerConsistent`, forcing regeneration. When the caller doesn't thread a
// realOffer, the check is skipped locally so a legitimate no-offer render is never false-failed.

test("qaCreativeViaBoxSession — a QC session that fails ONLY on offerConsistent (with a realOffer supplied) FAILS the whole verdict", async () => {
  // The mismatch this fixture reproduces: our REAL offer is "Up to 34% off + free shipping" but the
  // rendered image shows a competitor's "50% OFF" leaked from a reused hook (the 2026-07-14 Amazing
  // Creamer regression). A cooperative QC session reports offerConsistent:false and every other
  // check true — the whole verdict must fail so Dahlia regenerates rather than binning the mis-stated
  // discount.
  const buffer = await makeRedJpeg();
  let capturedPrompt = "";
  const dispatch = async (prompt: string, _allowedImagePath: string) => {
    capturedPrompt = prompt;
    return { resultText: verdictJson({ checks: { offerConsistent: false } }), isError: false };
  };
  const verdict = await qaCreativeViaBoxSession(
    {
      buffer,
      expectedCopy: { headline: "steady morning energy", offer: "Up to 34% off + free shipping", trust: "10k reviews" },
      realOffer: { headline: "Up to 34% off + free shipping", strikethrough: null, perServing: null },
    },
    dispatch,
  );
  // The QC session must have been told what our real offer actually is (via the TRUSTED outer rule).
  assert.match(capturedPrompt, /OFFER-CONSISTENCY MODE — REAL-OFFER/);
  assert.match(capturedPrompt, /Up to 34% off \+ free shipping/, "the real-offer text is embedded in the QC prompt so the vision model has a source of truth to compare against");
  // Enforcement — realOffer was threaded, model said false → verdict fails.
  assert.equal(verdict.checks.offerConsistent, false, "offerConsistent mirrors the QC verdict when a realOffer was threaded");
  assert.equal(verdict.pass, false, "a single failing check fails the whole QC verdict — the mis-stated discount does not land");
  assert.ok(verdict.issues.some((i) => i.includes("offerConsistent")), "the failure carries an offerConsistent issue so the regenerate-loop's log surfaces the reason");
});

test("qaCreativeViaBoxSession — no realOffer supplied → skip forces checks.offerConsistent=true regardless of the model's answer", async () => {
  // Symmetric to the packagingFaithful skip fixture (test 1 above): a caller that doesn't thread
  // realOffer (own-brand no-offer render, or a legacy invocation) must never be false-failed by a
  // spuriously-false CHECK. The local override neutralizes the field, and the outer TRUSTED
  // prompt tells the QC to skip the check up front. Same shape as that fixture — pass:true is
  // supplied explicitly because our top-level `pass` gate trusts the model's summary when true
  // (the local override is defence-in-depth against a spuriously-false CHECK field, not against
  // a spuriously-false top-level pass).
  const buffer = await makeRedJpeg();
  let capturedPrompt = "";
  const dispatch = async (prompt: string, _allowedImagePath: string) => {
    capturedPrompt = prompt;
    return { resultText: verdictJson({ pass: true, checks: { offerConsistent: false } }), isError: false };
  };
  const verdict = await qaCreativeViaBoxSession(
    { buffer, expectedCopy: { headline: "Hi", offer: null, trust: "10k reviews" } },
    dispatch,
  );
  // The outer rule tells the QC to SKIP the check when no real offer is threaded.
  assert.match(capturedPrompt, /OFFER-CONSISTENCY MODE — NO REFERENCE/);
  assert.equal(verdict.checks.offerConsistent, true, "no realOffer supplied → local skip forces the field to true");
  assert.equal(verdict.pass, true, "verdict passes on skip — no legitimate no-offer render is false-failed");
});

test("qaCreativeViaBoxSession — all checks true INCLUDING offerConsistent with a threaded realOffer → verdict passes", async () => {
  // Positive path — real offer threaded, image is consistent with it, every check passes: the ad
  // reaches the bin. Also serves as the smoke test that the new field being present in the response
  // doesn't accidentally regress the pass semantic.
  const buffer = await makeRedJpeg();
  const dispatch = async () => ({ resultText: verdictJson({}), isError: false });
  const verdict = await qaCreativeViaBoxSession(
    {
      buffer,
      expectedCopy: { headline: "steady morning energy", offer: "Up to 34% off + free shipping", trust: "10k reviews" },
      realOffer: { headline: "Up to 34% off + free shipping", strikethrough: null, perServing: "$1.20/serving vs a $4–8 coffee/latte" },
    },
    dispatch,
  );
  assert.equal(verdict.checks.offerConsistent, true);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.issues, []);
});
