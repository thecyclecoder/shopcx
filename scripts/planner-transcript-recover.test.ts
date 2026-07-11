/**
 * planner-transcript-recover — unit tests for the transcript fallback that
 * recovers a completed planner result whose primary parse dropped specs.
 *
 * Named failing state pinned here: a 6-spec, 50KB+ planner envelope written
 * as the LAST assistant message on the transcript must recover all 6 specs,
 * and an oversized envelope must not be silently truncated.
 *
 *   npx tsx --test scripts/planner-transcript-recover.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractSpecsFromTranscriptText } from "./planner-transcript-recover";

function assistantLine(text: string): string {
  return JSON.stringify({
    timestamp: "2026-07-11T00:00:00Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function userLine(text: string): string {
  return JSON.stringify({
    timestamp: "2026-07-11T00:00:00Z",
    message: { role: "user", content: text },
  });
}

function makeSpec(slug: string, filler: string): Record<string, unknown> {
  return {
    slug,
    summary: `Summary for ${slug}: ${filler}`,
    why: `Why ${slug} exists — ${filler}`,
    what: `What ${slug} ships — ${filler}`,
    milestone: "M1",
    blocked_by: [],
    phases: [
      {
        title: `Phase 1 — ${slug}`,
        why: `Phase why ${filler}`,
        what: `Phase what ${filler}`,
        body: `Phase body citing tables/libraries: ${filler}`,
        verification: `- On the box, run X → expect Y (${filler})`,
      },
    ],
  };
}

test("recovers a 6-spec 50KB+ planner envelope from the last assistant message", () => {
  const filler = "x".repeat(1200); // pushes each spec > 1.5KB so the envelope crosses 50KB
  const slugs = ["a-alpha", "b-bravo", "c-charlie", "d-delta", "e-echo", "f-foxtrot"];
  const envelope = { status: "completed", specs: slugs.map((s) => makeSpec(s, filler)) };
  const envelopeText = JSON.stringify(envelope);
  assert.ok(envelopeText.length > 50_000, `envelope must exceed 50KB (was ${envelopeText.length}B)`);
  const jsonl = [
    userLine("please author these specs"),
    assistantLine("here you go:\n" + envelopeText),
  ].join("\n") + "\n";

  const recovered = extractSpecsFromTranscriptText(jsonl);
  assert.equal(recovered.length, 6, "all 6 specs must be recovered");
  const recoveredSlugs = recovered.map((s) => s.slug).sort();
  assert.deepEqual(recoveredSlugs, [...slugs].sort());
});

test("prefers the LAST assistant envelope when an earlier assistant emitted a partial one", () => {
  const partial = { status: "completed", specs: [makeSpec("early", "e")] };
  const full = { status: "completed", specs: [makeSpec("one", "1"), makeSpec("two", "2"), makeSpec("three", "3")] };
  const jsonl = [
    userLine("start"),
    assistantLine("first try: " + JSON.stringify(partial)),
    userLine("please retry with all three"),
    assistantLine("done: " + JSON.stringify(full)),
  ].join("\n") + "\n";

  const recovered = extractSpecsFromTranscriptText(jsonl);
  assert.deepEqual(recovered.map((s) => s.slug).sort(), ["one", "three", "two"]);
});

test("recovers a fenced ```json``` envelope wrapped in prose", () => {
  const envelope = { status: "completed", specs: [makeSpec("only", "z")] };
  const text = "Here are the authored specs:\n\n```json\n" + JSON.stringify(envelope) + "\n```\n\nHope this helps.";
  const jsonl = [userLine("start"), assistantLine(text)].join("\n") + "\n";

  const recovered = extractSpecsFromTranscriptText(jsonl);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].slug, "only");
});

test("ignores tool_use / tool_result blocks and skips user turns", () => {
  const envelope = { status: "completed", specs: [makeSpec("real", "r")] };
  const rowWithToolUse = JSON.stringify({
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "1", name: "Read", input: { path: "x" } },
      ],
    },
  });
  const rowWithToolResult = JSON.stringify({
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "1", content: "" }],
    },
  });
  const jsonl = [
    userLine("start"),
    rowWithToolUse,
    rowWithToolResult,
    assistantLine("final:\n" + JSON.stringify(envelope)),
  ].join("\n") + "\n";

  const recovered = extractSpecsFromTranscriptText(jsonl);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].slug, "real");
});

test("returns [] when no assistant message carries a specs[] envelope", () => {
  const jsonl = [
    userLine("start"),
    assistantLine("I refuse — questions first."),
  ].join("\n") + "\n";

  const recovered = extractSpecsFromTranscriptText(jsonl);
  assert.deepEqual(recovered, []);
});

test("survives a truncated tail line (in-flight jsonl) without crashing", () => {
  const envelope = { status: "completed", specs: [makeSpec("good", "g")] };
  const good = assistantLine("done: " + JSON.stringify(envelope));
  // Simulate an in-flight tail: a partial jsonl line with no newline.
  const jsonl = [userLine("start"), good].join("\n") + "\n" + '{"message":{"role":"assis';

  const recovered = extractSpecsFromTranscriptText(jsonl);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].slug, "good");
});
