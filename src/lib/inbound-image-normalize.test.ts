/**
 * Unit tests for inbound image-only detection — the guard that stops an image-only reply
 * (a photo with no caption) from being mis-classified as an empty inbound and silently skipped.
 *
 * Run: npx tsx --test src/lib/inbound-image-normalize.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  inboundHasImage,
  strippedInboundText,
  classifyEmptyInbound,
  IMAGE_ONLY_INBOUND_MARKER,
} from "./inbound-image-normalize";

test("inline base64 photo with no text → image-only (must NOT skip)", () => {
  const body = `<div><img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."></div>`;
  const c = classifyEmptyInbound(body);
  assert.equal(c.isEmptyText, true);
  assert.equal(c.isImageOnly, true);
});

test("<img> tag with a remote src, no text → image-only", () => {
  const body = `<img src="https://mail.google.com/photo.jpg" alt="">`;
  assert.equal(classifyEmptyInbound(body).isImageOnly, true);
});

test("bare image URL as the whole body → non-empty TEXT (flows normally, not the skip path)", () => {
  const body = `https://cdn.example.com/receipt.PNG`;
  assert.equal(inboundHasImage(body), true);
  // The URL survives stripping as text, so the empty-inbound guard never fires — the pipeline
  // handles it as an ordinary (non-empty) message. isImageOnly is reserved for empty-of-text bodies.
  assert.equal(classifyEmptyInbound(body).isEmptyText, false);
  assert.equal(classifyEmptyInbound(body).isImageOnly, false);
});

test("genuinely empty (only tags/whitespace, no image) → skip, NOT image-only", () => {
  const body = `<div><br></div>  &nbsp; `;
  const c = classifyEmptyInbound(body);
  assert.equal(c.isEmptyText, true);
  assert.equal(c.isImageOnly, false);
});

test("real text (even with an image) → not empty, not image-only-skip-case", () => {
  const body = `Here is the photo you asked for <img src="data:image/png;base64,AAA">`;
  const c = classifyEmptyInbound(body);
  assert.equal(c.isEmptyText, false);
  assert.equal(c.isImageOnly, false); // has text — the normal pipeline handles it as-is
  assert.equal(strippedInboundText(body), "Here is the photo you asked for");
});

test("plain empty string → empty, not image-only", () => {
  const c = classifyEmptyInbound("");
  assert.equal(c.isEmptyText, true);
  assert.equal(c.isImageOnly, false);
});

test("marker is non-empty plain text (safe to feed the orchestrator as newest message)", () => {
  assert.ok(IMAGE_ONLY_INBOUND_MARKER.length > 0);
  assert.doesNotMatch(IMAGE_ONLY_INBOUND_MARKER, /<[^>]+>/); // no HTML
});
