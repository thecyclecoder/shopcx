/**
 * planner-transcript-recover — transcript fallback for runPlanJob's authoring
 * step in scripts/builder-worker.ts.
 *
 * When the planner returns a large multi-spec envelope (~50KB+, 6+ specs), the
 * primary parse of `claude -p`'s stream-json `result` event has been observed
 * to yield zero specs even though the final assistant message on disk carried
 * every one of them fully authored (job d5999907 was recovered by hand this
 * way). This module makes that recovery automatic: given the planner's
 * session_id, re-scan the session's transcript jsonl for the LAST assistant
 * message whose text parses as `{status, specs:[...]}` and return the specs.
 *
 * Docs: docs/brain/specs/planner-authoring-survives-large-multi-spec-output.md
 * Phase 1 — Never lose a completed planner result.
 */
import { readFileSync } from "fs";
import { findTranscriptAcrossProjects } from "./pulse-recap";

/**
 * Loose shape for a recovered spec — mirrors runPlanJob's local `PlannerSpecOut`
 * (scripts/builder-worker.ts). Only `slug` is required for the caller's merge
 * loop; the caller re-validates every field before authoring.
 */
export type RecoveredSpec = { slug?: string } & Record<string, unknown>;

/**
 * Parse a large JSON envelope out of an arbitrary text blob. Same three-strategy
 * scan as `extractJson` in scripts/builder-worker.ts (whole-text → last fenced
 * ```json``` block → outermost balanced `{...}` scanned right-to-left).
 * Duplicated here so the recovery helper can be tested and imported without
 * pulling in the whole worker file. Kept in lockstep with the worker copy —
 * both accept the same shapes; a divergence would be a bug.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(text.trim());
  if (whole) return whole;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const fenced = tryParse(fences[i][1].trim());
    if (fenced) return fenced;
  }
  const opens: number[] = [];
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) opens.push(i);
  const closes: number[] = [];
  for (let i = text.indexOf("}"); i >= 0; i = text.indexOf("}", i + 1)) closes.push(i);
  for (let e = closes.length - 1; e >= 0; e--) {
    const end = closes[e];
    for (const start of opens) {
      if (start >= end) break;
      const parsed = tryParse(text.slice(start, end + 1));
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * Pure: given the raw contents of a Claude Code session transcript jsonl,
 * walk assistant messages from newest → oldest and return the first non-empty
 * `specs[]` extracted from an assistant message's text.
 *
 * Transcript rows look like `{message: {role, content}}` where `content` is
 * either a string or an array of blocks. Assistant text lives in `text` blocks;
 * `tool_use` / `tool_result` blocks are ignored (they're the SDK's tool
 * plumbing, not the planner's final envelope).
 */
export function extractSpecsFromTranscriptText(text: string): RecoveredSpec[] {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = row.message as Record<string, unknown> | undefined;
    if (!msg || msg.role !== "assistant") continue;
    let msgText = "";
    const content = msg.content;
    if (typeof content === "string") {
      msgText = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") msgText += b.text;
      }
    }
    if (!msgText) continue;
    const obj = extractJsonObject(msgText);
    if (obj && Array.isArray(obj.specs) && obj.specs.length) {
      return obj.specs as RecoveredSpec[];
    }
  }
  return [];
}

/**
 * File-IO shim: locate the session's transcript across every `~/.claude/projects/*`
 * dir (a session that ran in a git worktree lives under that cwd's slug, not
 * the current cwd's), read it, and run `extractSpecsFromTranscriptText`.
 *
 * Returns `{ specs: [], transcriptPath: null }` when the transcript can't be
 * located, `{ specs: [], transcriptPath: <fp> }` when the transcript exists but
 * no assistant message carried a `specs[]` envelope.
 */
export function recoverSpecsForSession(sessionId: string): { specs: RecoveredSpec[]; transcriptPath: string | null } {
  const fp = findTranscriptAcrossProjects(sessionId);
  if (!fp) return { specs: [], transcriptPath: null };
  let text: string;
  try {
    text = readFileSync(fp, "utf8");
  } catch {
    return { specs: [], transcriptPath: fp };
  }
  return { specs: extractSpecsFromTranscriptText(text), transcriptPath: fp };
}
