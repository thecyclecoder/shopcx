/**
 * graduate-vera — redirectUrlToPreview: a pre-merge http_get check that targets shopcx.ai must hit THIS
 * build's preview origin (the branch's code isn't on prod yet), while external / relative URLs and the
 * post-ship (no previewOrigin) case are left untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { redirectUrlToPreview } from "./spec-check-runner";

const PREVIEW = "https://shopcx-abc123-xxx.vercel.app";

test("rewrites a shopcx.ai target to the preview origin, preserving path + query", () => {
  assert.equal(redirectUrlToPreview("https://shopcx.ai/api/foo?x=1", PREVIEW), "https://shopcx-abc123-xxx.vercel.app/api/foo?x=1");
});

test("rewrites a www./sub-domain shopcx.ai host too", () => {
  assert.equal(redirectUrlToPreview("https://www.shopcx.ai/dashboard", PREVIEW), "https://shopcx-abc123-xxx.vercel.app/dashboard");
});

test("leaves an EXTERNAL url untouched (never redirect a third-party)", () => {
  assert.equal(redirectUrlToPreview("https://api.stripe.com/v1/charges", PREVIEW), "https://api.stripe.com/v1/charges");
});

test("no previewOrigin (post-ship run) → unchanged", () => {
  assert.equal(redirectUrlToPreview("https://shopcx.ai/api/foo", null), "https://shopcx.ai/api/foo");
});

test("relative / unparseable url → unchanged", () => {
  assert.equal(redirectUrlToPreview("/api/foo", PREVIEW), "/api/foo");
});
