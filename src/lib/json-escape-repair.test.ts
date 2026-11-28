import test from "node:test";
import assert from "node:assert/strict";
import { repairInvalidJsonEscapes } from "./json-escape-repair";

test("doubles a non-JSON escape so a quoted regex parses", () => {
  const raw = '{"reasoning":"marker \\bid\\s+like\\b on that table"}';
  assert.throws(() => JSON.parse(raw));
  const o = JSON.parse(repairInvalidJsonEscapes(raw));
  assert.equal(o.reasoning, "marker \bid\\s+like\b on that table");
});

test("leaves legal escapes and already-escaped backslashes untouched", () => {
  const raw = '{"a":"line\\nnext \\"q\\" C:\\\\dir \\u00e9 \\/"}';
  assert.equal(repairInvalidJsonEscapes(raw), raw);
  assert.deepEqual(JSON.parse(repairInvalidJsonEscapes(raw)), JSON.parse(raw));
});

test("a bad \\u (not 4 hex digits) is doubled", () => {
  const raw = '{"a":"\\user"}';
  assert.equal(JSON.parse(repairInvalidJsonEscapes(raw)).a, "\\user");
});
