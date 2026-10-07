/**
 * Recovering a box session's final answer when the CLI's `result` event comes back blank — the pure
 * parsing behind [[../scripts/builder-worker.ts]] `runBoxSession`, kept in its own module so
 * [[../scripts/builder-worker.session-result.test.ts]] can pin it without importing the worker's `main()`.
 *
 * WHY (2026-10-07): from 2026-10-03 roughly half of Sol's ticket-handle sessions (and most cs-director-call
 * / agent-grade sessions) finished normally (`subtype:"success"`, `is_error:false`, 10k+ output tokens) but
 * with `"result":""` — the last turn emitted ~2 tokens. Every lane parses its JSON out of `resultText`, so a
 * blank final answer failed the job ("Sol first-touch returned no completed direction JSON") and the ticket
 * fell to a human, even though the agent had written its answer in an earlier assistant message.
 *
 * Recovery order (the caller does step 3):
 *   1. the `result` event's text, when non-blank;
 *   2. else the LAST assistant text block in the stream that carries a JSON object (the answer the agent
 *      already wrote — every box lane ends on a JSON verdict);
 *   3. else one `--resume` nudge on the same session asking it to restate its final output.
 */

export interface ParsedSessionStream {
  session: string | null;
  /** Text of the last `{type:"result"}` event ("" when blank); null when there was no result event. */
  resultText: string | null;
  resultIsError: boolean;
  /** The last non-blank `text` block of any `{type:"assistant"}` event, or null. */
  lastAssistantText: string | null;
  /** The last assistant `text` block that contains a `{…}` JSON object, or null. */
  lastAssistantJsonText: string | null;
  /** The raw last result event object (for usage metering), or null. */
  resultEvent: Record<string, unknown> | null;
}

export function parseSessionStream(out: string, initialSession: string | null): ParsedSessionStream {
  let session = initialSession;
  let resultText: string | null = null;
  let resultIsError = false;
  let lastAssistantText: string | null = null;
  let lastAssistantJsonText: string | null = null;
  let resultEvent: Record<string, unknown> | null = null;
  for (const line of (out || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!obj || typeof obj !== "object") continue;
    if (typeof obj.session_id === "string") session = obj.session_id;
    if (obj.type === "assistant") {
      const content = (obj.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: unknown; text?: unknown };
          if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            lastAssistantText = b.text;
            if (/\{[\s\S]*\}/.test(b.text)) lastAssistantJsonText = b.text;
          }
        }
      }
    } else if (obj.type === "result") {
      resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj);
      resultIsError = obj.is_error === true;
      resultEvent = obj;
    }
  }
  return { session, resultText, resultIsError, lastAssistantText, lastAssistantJsonText, resultEvent };
}

export type FinalTextSource = "result" | "assistant_fallback" | "blank";

// Steps 1–2. A failed run (is_error) keeps its result text as-is — the error wording drives the
// usage-wall / auth classifiers, so it must never be swapped for an earlier assistant message.
export function chooseFinalText(p: ParsedSessionStream): { text: string; source: FinalTextSource } {
  const result = p.resultText ?? "";
  if (result.trim() || p.resultIsError) return { text: result, source: "result" };
  // Only an earlier message that carries a JSON object counts as "the answer" — every box lane ends on a
  // JSON verdict, and a narration line ("Let me look up the order.") would just fail the lane's parse.
  // Anything else falls through to the resume nudge.
  if (p.lastAssistantJsonText) return { text: p.lastAssistantJsonText, source: "assistant_fallback" };
  return { text: result, source: "blank" };
}

// Step 3's prompt — resumed on the SAME session (same account + cwd), so the agent still has its work.
export const BLANK_RESULT_NUDGE_PROMPT =
  "Your previous turn ended with an empty final message, so the worker received nothing. " +
  "Do not redo any work or call any tools. Reply now with ONLY the final output your instructions asked for " +
  "(usually a single JSON object), exactly as you would have ended your turn.";
