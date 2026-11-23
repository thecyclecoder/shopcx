import { test } from "node:test";
import assert from "node:assert/strict";
import { isWinbackSentinel, buildWinbackRedirect } from "./winback-shortlink";

const target = "https://shopcx.ai/journey/@winback?fallback=https%3A%2F%2Fsuperfoodscompany.com&utm_source=shopcx_sms&utm_campaign=c1";

test("detects the sentinel path only", () => {
  assert.equal(isWinbackSentinel(target), true);
  assert.equal(isWinbackSentinel("https://shopcx.ai/journey/abc"), false);
  assert.equal(isWinbackSentinel("not a url"), false);
});

test("token → the customer's own journey, UTMs kept, fallback stripped", () => {
  assert.equal(
    buildWinbackRedirect(target, "TOK123"),
    "https://shopcx.ai/journey/TOK123?utm_source=shopcx_sms&utm_campaign=c1",
  );
});

test("no token → fallback, else site root", () => {
  assert.equal(buildWinbackRedirect(target, null), "https://superfoodscompany.com/");
  assert.equal(buildWinbackRedirect("https://shopcx.ai/journey/@winback", null), "https://shopcx.ai/");
});
