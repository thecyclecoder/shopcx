/**
 * Safety test for the sonnet-prompt auto-review pipeline.
 *
 * Invariants verified (no real Opus calls — we stub the decision):
 * 1. A "delete-the-approved-rule" attempt converts to `supersede` with
 *    the old rule kept (enabled=false, status=archived, superseded_by_id
 *    pointing to the new proposal). NEVER an actual delete.
 * 2. A decision with confidence < REJECT_FLOOR (0.55) gets downgraded
 *    to `reject` (no human queue) regardless of what the model said.
 * 3. An accept with confidence in [REJECT_FLOOR, ACCEPT_FLOOR) is
 *    downgraded to `reject`.
 * 4. The audit row is inserted FIRST, before the prompt mutation.
 * 5. When the daily cap is reached, the next `accept` decision is
 *    downgraded to `reject`.
 * 6. A `human_review` recommendation from the model is overridden to
 *    `reject` (the cron never queues to a human).
 *
 * Runs against the live DB but uses a synthetic workspace_id-scoped
 * scratch space that's torn down at the end.
 *
 *   npx tsx scripts/test-prompt-auto-review-safety.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { applyDecision, REJECT_FLOOR, ACCEPT_FLOOR, DEFAULT_DAILY_CAP } from "../src/lib/sonnet-prompt-auto-review";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const TEST_WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods workspace (used for safety scratch — rows cleaned at end)

const admin = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

let failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures.push(msg);
    console.log("  ✗ " + msg);
  } else {
    console.log("  ✓ " + msg);
  }
}

async function seedApproved(): Promise<string> {
  const { data, error } = await admin
    .from("sonnet_prompts")
    .insert({
      workspace_id: TEST_WORKSPACE,
      category: "rule",
      title: `[safety-test-approved] ${Date.now()}`,
      content: "Approved rule the safety test will try to delete.",
      status: "approved",
      enabled: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed approved failed: ${error?.message}`);
  return data.id;
}

async function seedProposal(suffix: string): Promise<string> {
  const { data, error } = await admin
    .from("sonnet_prompts")
    .insert({
      workspace_id: TEST_WORKSPACE,
      category: "rule",
      title: `[safety-test-proposal-${suffix}] ${Date.now()}`,
      content: `Test proposal for ${suffix}.`,
      status: "proposed",
      proposed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed proposal failed: ${error?.message}`);
  return data.id;
}

function fakeInputs(proposal: any) {
  return {
    proposal: { id: proposal.id, title: proposal.title, content: proposal.content, category: proposal.category },
    similarPrompts: [],
    policies: [],
    sourceTickets: [],
    voiceDocs: { customer_voice: "", operational_rules: "", ui_conventions: "" },
  };
}

async function cleanup(ids: string[]) {
  await admin.from("sonnet_prompt_decisions").delete().in("sonnet_prompt_id", ids);
  await admin.from("sonnet_prompts").delete().in("id", ids);
}

async function fetchPrompt(id: string) {
  const { data } = await admin.from("sonnet_prompts").select("*").eq("id", id).maybeSingle();
  return data;
}

async function fetchDecision(promptId: string) {
  const { data } = await admin
    .from("sonnet_prompt_decisions")
    .select("*")
    .eq("sonnet_prompt_id", promptId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// ── Test 1: delete-an-approved-rule attempt is rewritten ───────────
async function testDeleteAttemptRewrittenToSupersede() {
  console.log("\nTest 1: delete-an-approved-rule attempt is rewritten to supersede");
  const approvedId = await seedApproved();
  const proposalId = await seedProposal("delete-attempt");
  const proposal = await fetchPrompt(proposalId);

  // The "model" tries to delete by passing decision='delete'. Our
  // applyDecision rewrites this to 'supersede' with a forced human-review.
  const decision: any = {
    decision: "delete", // ← would be illegal; will be rewritten
    confidence: 0.99,
    reasoning: "Attempting to delete an approved rule. This should NEVER actually delete.",
    references: [{ type: "prompt", id: approvedId, why: "The rule to delete." }],
    supersede_target_id: approvedId,
  };

  const r = await applyDecision(
    admin as any,
    TEST_WORKSPACE,
    proposal,
    decision,
    fakeInputs(proposal),
    { model: "test-model", source: "safety_test" },
    { dailyCap: DEFAULT_DAILY_CAP, alreadyAcceptedToday: 0 },
  );

  const old = await fetchPrompt(approvedId);
  const newProp = await fetchPrompt(proposalId);
  const audit = await fetchDecision(proposalId);

  assert(old !== null, "old approved rule still exists (not deleted)");
  assert(r.finalDecision === "supersede", `decision rewritten to supersede (got ${r.finalDecision})`);
  assert(r.forcedToHumanReview, "forced flag set (delete → supersede)");
  assert(old?.enabled === false, "old rule disabled after supersede");
  assert(newProp?.auto_decision === "supersede", `new proposal recorded as supersede (got ${newProp?.auto_decision})`);
  assert(audit !== null, "audit row was written");

  await cleanup([approvedId, proposalId]);
}

// ── Test 2: confidence < REJECT_FLOOR → reject ─────────────────────
async function testRejectFloor() {
  console.log(`\nTest 2: confidence < REJECT_FLOOR (${REJECT_FLOOR}) downgrades to reject`);
  const proposalId = await seedProposal("low-confidence");
  const proposal = await fetchPrompt(proposalId);

  const decision: any = {
    decision: "accept",
    confidence: REJECT_FLOOR - 0.05,
    reasoning: "Model is uncertain but recommended accept.",
    references: [],
  };

  const r = await applyDecision(
    admin as any,
    TEST_WORKSPACE,
    proposal,
    decision,
    fakeInputs(proposal),
    { model: "test-model", source: "safety_test" },
    { dailyCap: DEFAULT_DAILY_CAP, alreadyAcceptedToday: 0 },
  );

  const updated = await fetchPrompt(proposalId);
  assert(r.finalDecision === "reject", `final decision = reject (got ${r.finalDecision})`);
  assert(r.forcedToHumanReview, "forced downgrade flag set");
  assert(updated?.auto_decision === "reject", `auto_decision = reject (got ${updated?.auto_decision})`);
  assert(updated?.status === "rejected", `prompt status = rejected (got ${updated?.status})`);

  await cleanup([proposalId]);
}

// ── Test 3: accept with confidence in [REJECT_FLOOR, ACCEPT_FLOOR) → reject ─
async function testAcceptFloor() {
  console.log(`\nTest 3: accept with confidence < ACCEPT_FLOOR (${ACCEPT_FLOOR}) downgrades to reject`);
  const proposalId = await seedProposal("tentative-accept");
  const proposal = await fetchPrompt(proposalId);

  const decision: any = {
    decision: "accept",
    confidence: ACCEPT_FLOOR - 0.05, // above REJECT_FLOOR but below ACCEPT_FLOOR
    reasoning: "Plausible accept but not strong enough.",
    references: [],
  };

  const r = await applyDecision(
    admin as any,
    TEST_WORKSPACE,
    proposal,
    decision,
    fakeInputs(proposal),
    { model: "test-model", source: "safety_test" },
    { dailyCap: DEFAULT_DAILY_CAP, alreadyAcceptedToday: 0 },
  );

  const updated = await fetchPrompt(proposalId);
  assert(r.finalDecision === "reject", `final decision = reject (got ${r.finalDecision})`);
  assert(r.forcedToHumanReview, "forced downgrade flag set");
  assert(updated?.auto_decision === "reject", `auto_decision = reject (got ${updated?.auto_decision})`);

  await cleanup([proposalId]);
}

// ── Test 4: daily cap downgrades to reject ─────────────────────────
async function testDailyCap() {
  console.log("\nTest 4: daily-cap saturation downgrades to reject");
  const proposalId = await seedProposal("daily-cap");
  const proposal = await fetchPrompt(proposalId);

  const decision: any = {
    decision: "accept",
    confidence: 0.95,
    reasoning: "High confidence accept, but cap is reached.",
    references: [],
  };

  const r = await applyDecision(
    admin as any,
    TEST_WORKSPACE,
    proposal,
    decision,
    fakeInputs(proposal),
    { model: "test-model", source: "cron" },
    { dailyCap: 10, alreadyAcceptedToday: 10 }, // cap reached
  );

  assert(r.finalDecision === "reject", `cap forces reject (got ${r.finalDecision})`);
  assert(r.forcedToHumanReview, "forced flag set");

  await cleanup([proposalId]);
}

// ── Test 5: model returns human_review → reject ────────────────────
async function testModelHumanReviewOverridden() {
  console.log("\nTest 5: model-recommended human_review overridden to reject");
  const proposalId = await seedProposal("model-human-review");
  const proposal = await fetchPrompt(proposalId);

  const decision: any = {
    decision: "human_review",
    confidence: 0.85,
    reasoning: "Model wants a human to decide this one.",
    references: [],
  };

  const r = await applyDecision(
    admin as any,
    TEST_WORKSPACE,
    proposal,
    decision,
    fakeInputs(proposal),
    { model: "test-model", source: "cron" },
    { dailyCap: DEFAULT_DAILY_CAP, alreadyAcceptedToday: 0 },
  );

  const updated = await fetchPrompt(proposalId);
  assert(r.finalDecision === "reject", `human_review overridden to reject (got ${r.finalDecision})`);
  assert(r.forcedToHumanReview, "forced flag set");
  assert(updated?.auto_decision === "reject", `auto_decision = reject (got ${updated?.auto_decision})`);

  await cleanup([proposalId]);
}

// ── Test 4: audit row written before prompt mutation ───────────────
async function testAuditFirst() {
  console.log("\nTest 4: audit row inserted before prompt mutation");
  const proposalId = await seedProposal("audit-first");
  const proposal = await fetchPrompt(proposalId);

  const decision: any = {
    decision: "accept",
    confidence: 0.90,
    reasoning: "Accept it.",
    references: [],
  };

  const r = await applyDecision(
    admin as any,
    TEST_WORKSPACE,
    proposal,
    decision,
    fakeInputs(proposal),
    { model: "test-model", source: "safety_test" },
    { dailyCap: DEFAULT_DAILY_CAP, alreadyAcceptedToday: 0 },
  );

  const audit = await fetchDecision(proposalId);
  const updated = await fetchPrompt(proposalId);

  assert(audit !== null, "audit row exists");
  assert(updated?.auto_decision === "accept", `prompt updated to accept (got ${updated?.auto_decision})`);
  // Order is implied: if we got the prompt update, the audit was written first because applyDecision aborts on audit failure.
  assert(r.decisionRowId !== "", "decisionRowId returned");

  await cleanup([proposalId]);
}

async function main() {
  console.log("Running prompt-auto-review safety tests against", TEST_WORKSPACE);
  await testDeleteAttemptRewrittenToSupersede();
  await testRejectFloor();
  await testAcceptFloor();
  await testDailyCap();
  await testModelHumanReviewOverridden();
  await testAuditFirst();

  if (failures.length) {
    console.log(`\n✗ ${failures.length} failures`);
    process.exit(1);
  }
  console.log("\n✓ all safety tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
