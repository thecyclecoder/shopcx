/**
 * Unit tests for `detectPlaybookSuperseder` — the pure predicate the unified ticket handler
 * calls to decide whether the active playbook should be cleared before the next inbound turn.
 *
 * Mirrors the Phase-1 verification bullet of
 * docs/brain/specs/post-resolution-inbound-reroute-and-silent-turn-guard.md — the handler
 * supersedes a playbook on a CS-Director resolution (widened from agent-reply-only).
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/playbook-supersede-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectPlaybookSuperseder,
  playbookSupersedeReasonPhrase,
  CS_DIRECTOR_VERDICT_NOTE_PREFIX,
} from "./playbook-supersede-guard";

test("no supersede signal → null (playbook resumes normally)", () => {
  const reason = detectPlaybookSuperseder({
    hasExternalAgentReply: false,
    hasCsDirectorResolutionNote: false,
  });
  assert.equal(reason, null);
});

test("external human-agent reply → agent_reply (pre-existing behavior preserved)", () => {
  const reason = detectPlaybookSuperseder({
    hasExternalAgentReply: true,
    hasCsDirectorResolutionNote: false,
  });
  assert.equal(reason, "agent_reply");
});

test("CS-Director resolution note alone → director_resolution (Phase 1 widening)", () => {
  const reason = detectPlaybookSuperseder({
    hasExternalAgentReply: false,
    hasCsDirectorResolutionNote: true,
  });
  assert.equal(reason, "director_resolution");
});

test("both signals present → agent_reply outranks (human reply is the stronger signal)", () => {
  const reason = detectPlaybookSuperseder({
    hasExternalAgentReply: true,
    hasCsDirectorResolutionNote: true,
  });
  assert.equal(reason, "agent_reply");
});

test("reason phrases match the sysNote wording contract", () => {
  assert.match(playbookSupersedeReasonPhrase("agent_reply"), /human agent has replied/);
  assert.match(playbookSupersedeReasonPhrase("director_resolution"), /CS Director has resolved/);
});

test("verdict-note prefix matches buildCsDirectorVerdictNote's actual header", () => {
  // Regression pin: the handler ilike-matches on this exact prefix, so a drift in
  // src/lib/cs-director-verdict-note.ts's `[CS Director review]` header would silently
  // break the widened supersede path. Keep them in lockstep.
  assert.equal(CS_DIRECTOR_VERDICT_NOTE_PREFIX, "[CS Director review]");
});
