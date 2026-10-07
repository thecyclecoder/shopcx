/**
 * Unit tests for [[../scripts/builder-worker.session-result.ts]] — a blank final `result` no longer
 * fails a box session whose agent already wrote its answer.
 *
 *   npx tsx --test scripts/builder-worker.session-result.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chooseFinalText, parseSessionStream } from "./builder-worker.session-result";

const lines = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");
const assistant = (...texts: string[]) => ({ type: "assistant", message: { content: texts.map((t) => ({ type: "text", text: t })) } });
const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } };
const result = (text: string, isError = false) => ({ type: "result", subtype: "success", is_error: isError, result: text, session_id: "s-1" });

test("a non-blank result wins", () => {
  const p = parseSessionStream(lines(assistant("thinking out loud"), result('{"ok":true}')), null);
  assert.deepEqual(chooseFinalText(p), { text: '{"ok":true}', source: "result" });
  assert.equal(p.session, "s-1");
});

test("blank result → falls back to the last non-blank assistant text (the 2026-10-03 regression)", () => {
  const out = lines(assistant("Let me look up the order."), toolUse, assistant('{"intent":"refund"}'), assistant("   "), toolUse, result(""));
  assert.deepEqual(chooseFinalText(parseSessionStream(out, null)), { text: '{"intent":"refund"}', source: "assistant_fallback" });
});

test("blank result whose last assistant text is narration, not JSON → blank (nudge), not the narration", () => {
  const out = lines(assistant('{"intent":"refund"}'), toolUse, assistant("Done — sending the reply now."), result(""));
  assert.deepEqual(chooseFinalText(parseSessionStream(out, null)), { text: '{"intent":"refund"}', source: "assistant_fallback" });
  assert.equal(chooseFinalText(parseSessionStream(lines(assistant("Let me look up the order."), result("")), null)).source, "blank");
});

test("blank result and no assistant text → blank (the caller nudges)", () => {
  assert.equal(chooseFinalText(parseSessionStream(lines(toolUse, result("")), null)).source, "blank");
});

test("an error result is never replaced by earlier assistant text (wall/auth classifiers read it)", () => {
  const p = parseSessionStream(lines(assistant('{"x":1}'), result("", true)), null);
  assert.equal(chooseFinalText(p).source, "result");
});

test("no result event at all → resultText null; garbage lines are skipped", () => {
  const p = parseSessionStream("not json\n" + lines(assistant("hi")), "pre");
  assert.equal(p.resultText, null);
  assert.equal(p.session, "pre");
  assert.equal(p.lastAssistantText, "hi");
});
