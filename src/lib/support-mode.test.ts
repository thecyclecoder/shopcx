/**
 * Pins the per-workspace support-mode switch (src/lib/support-mode.ts).
 *
 * The invariant that protects Superfoods: any failure to read the mode degrades to 'cpg', and the
 * pure predicates decide whether the CPG pipeline runs (shouldRunCpgSteps) and whether a CPG action
 * may dispatch (isActionAllowedInMode). A 'software' workspace skips the CPG steps and refuses CPG
 * actions; 'cpg' behaves exactly as today.
 *
 * Run: npx tsx --test src/lib/support-mode.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getSupportMode,
  isSoftwareMode,
  shouldRunCpgSteps,
  isActionAllowedInMode,
} from "./support-mode";

test("isSoftwareMode distinguishes the two modes", () => {
  assert.equal(isSoftwareMode("software"), true);
  assert.equal(isSoftwareMode("cpg"), false);
});

test("shouldRunCpgSteps: only in cpg mode", () => {
  assert.equal(shouldRunCpgSteps("cpg"), true);
  assert.equal(shouldRunCpgSteps("software"), false);
});

test("isActionAllowedInMode: cpg allows every action type", () => {
  for (const t of ["direct_action", "journey", "playbook", "workflow", "ai_response", "kb_response", "escalate"]) {
    assert.equal(isActionAllowedInMode("cpg", t), true, `cpg should allow ${t}`);
  }
});

test("isActionAllowedInMode: software refuses the CPG action types", () => {
  for (const t of ["direct_action", "journey", "playbook", "workflow"]) {
    assert.equal(isActionAllowedInMode("software", t), false, `software should refuse ${t}`);
  }
});

test("isActionAllowedInMode: software still allows response/escalate + software-toolset actions", () => {
  for (const t of ["ai_response", "kb_response", "escalate", "software_action", "create_github_issue"]) {
    assert.equal(isActionAllowedInMode("software", t), true, `software should allow ${t}`);
  }
});

test("getSupportMode: empty workspaceId reads as cpg (fail-safe, no DB hit)", async () => {
  assert.equal(await getSupportMode(""), "cpg");
});

test("getSupportMode: a read error reads as cpg (never flips Superfoods into software)", async () => {
  // Clearing the Supabase env makes createAdminClient throw synchronously — the catch must yield 'cpg'.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "";
  try {
    // A workspace id never used elsewhere so the in-memory cache cannot mask the error path.
    assert.equal(await getSupportMode("00000000-0000-0000-0000-0000000000ee"), "cpg");
  } finally {
    if (url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  }
});
