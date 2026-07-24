/**
 * Pins the safety-net converter that turns a bare EasyPost return-label URL
 * into the styled CTA button. Wedge is ticket a00b0c22 (Jamie): the URL sits
 * alone on its own line, becomes `<p>https://easypost-files.s3…</p>` in HTML,
 * and the prior lookbehind that excluded `>` skipped it, shipping a raw S3
 * link instead of a button. The three cases lock the intended behavior:
 * paragraph-wrapped URL converts, mid-sentence URL still converts, and an
 * already-quoted href never double-wraps.
 *
 * Run: npx tsx --test src/lib/label-cta.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ctaButton, renderLabelUrlsAsButtons } from "./label-cta";

const LABEL_URL = "https://easypost-files.s3.us-west-2.amazonaws.com/x.png";

test("paragraph-wrapped label URL converts to a button", () => {
  const input = `<p>${LABEL_URL}</p>`;
  const output = renderLabelUrlsAsButtons(input);
  assert.ok(output.includes("<a href="), "output should contain an anchor tag");
  assert.ok(!output.includes(`>${LABEL_URL}<`), "output should not contain the bare URL as text between tags");
  assert.ok(!/>https?:\/\/easypost-files\.s3[^<]+</.test(output), "no bare label URL should remain as text");
});

test("already-rendered ctaButton output passes through unchanged (no double-wrap)", () => {
  const rendered = ctaButton(LABEL_URL, "Download your prepaid return label →");
  const output = renderLabelUrlsAsButtons(rendered);
  assert.equal(output, rendered);
  const anchorCount = (output.match(/<a href=/g) ?? []).length;
  assert.equal(anchorCount, 1, "exactly one anchor tag — no nested/double wrap");
});

test("bare label URL mid-sentence still converts", () => {
  const input = `Here is your label ${LABEL_URL} — please print it.`;
  const output = renderLabelUrlsAsButtons(input);
  assert.ok(output.includes("<a href="), "output should contain an anchor tag");
  assert.ok(!output.includes(LABEL_URL + " —"), "the bare URL should have been replaced");
});
