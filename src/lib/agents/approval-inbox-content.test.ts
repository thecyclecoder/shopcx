/**
 * Unit tests for `buildApprovalContent` — ask-first CEO cards (2026-08-11).
 *
 * THE PROBLEM. The card body was the raising action's `preview` verbatim, capped at 4000 chars. Agents
 * write a full diagnostic paragraph into `preview`, so the founder got a wall of prose whose actual
 * request — and often the agent's own recommendation — sat in the last two sentences. His words looking
 * at one: "honestly it's like a word wall i can barely understand."
 *
 * The fix: lead with the ASK (what Approve would DO), then the evidence below a rule. Nothing is lost;
 * it is just no longer the first thing on screen.
 *
 * Run:  npx tsx --test src/lib/agents/approval-inbox-content.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildApprovalContent, decisionLineFor, APPROVAL_EVIDENCE_MAX } from "./approval-inbox";

/** The real db_health card that motivated this — a 300-word preview with the ask buried at the end. */
const WALL_OF_TEXT =
  "Signature `dbhealth:slowq:-1756037457588317045` (queryid for `SELECT spec, phases FROM " +
  "public.get_spec_with_phases($1::uuid, $2::text)`) already has FOUR shipped fixes stacked on it: " +
  "(1) db-reduce-calls-q-1756037457588317045 (#1551) — 2s in-process getSpec cache; (2) " +
  "db-load-cut-getspec-amplifier-claim-fan-sidebar-spray (#1904) — killed duplicate reads; (3) " +
  "spec-read-efficiency-for-scaling-fleet (#1963) — LISTEN/NOTIFY event-driven invalidation; (4) " +
  "perf(specs): cut the whole-board spec read (#2151). The analyzer already has a rate self-clearing " +
  "branch that was purpose-built for this exact signature. Yet the pass is re-firing with numbers " +
  "essentially identical to the original template, which means one of: (a) the rate branch isn't " +
  "receiving a priorRow; (b) ephemeral subprocesses are re-hammering the RPC; or (c) a pg_stat_statements " +
  "reset made the cumulative fall-back fire honestly. Auto-approving materializes that same spec and " +
  "queues a build that will most likely return 'work already merged' and park at needs_attention.";

const job = {
  id: "j1",
  kind: "db_health",
  spec_slug: "dbhealth:slowq:-1756037457588317045",
  log_tail: null,
  pending_actions: [
    {
      id: "a1",
      type: "db_health_build",
      summary: "Build the index/caching fix for the specs slow query",
      preview: WALL_OF_TEXT,
      status: "pending",
    },
  ],
} as unknown as Parameters<typeof buildApprovalContent>[0];

test("the ASK comes first — the body opens with what Approve would DO, not the forensics", () => {
  const { body } = buildApprovalContent(job);
  assert.ok(body.startsWith("Approving:"), `body should open with the ask, got: ${body.slice(0, 60)}`);
  assert.ok(
    body.indexOf("Build the index/caching fix") < body.indexOf("Signature"),
    "the ask must appear before the evidence",
  );
});

test("the evidence is PRESERVED, just moved below the rule", () => {
  const { body } = buildApprovalContent(job);
  assert.match(body, /———\nWhy:/, "evidence sits under a labelled rule");
  assert.match(body, /already has FOUR shipped fixes/, "the diagnostic detail is not discarded");
});

test("evidence is bounded, and says so when truncated", () => {
  const huge = {
    ...(job as unknown as Record<string, unknown>),
    pending_actions: [
      { id: "a1", type: "db_health_build", summary: "Do the thing", preview: "x".repeat(9000), status: "pending" },
    ],
  } as unknown as typeof job;
  const { body } = buildApprovalContent(huge);
  assert.ok(body.length < 4000);
  assert.match(body, /truncated — full detail on the job/);
  assert.ok(body.startsWith("Approving:"), "the ask survives truncation — it is never what gets cut");
});

test("a BUNDLE says how many actions Approve would run, and lists each", () => {
  const bundle = {
    ...(job as unknown as Record<string, unknown>),
    pending_actions: [
      { id: "a1", type: "apply_migration", summary: "Add the index", cmd: "psql -f m.sql", status: "pending" },
      { id: "a2", type: "run_prod_script", summary: "Backfill the column", cmd: "tsx b.ts", status: "pending" },
    ],
  } as unknown as typeof job;
  const { body } = buildApprovalContent(bundle);
  assert.match(body, /Approving runs ALL 2 of these/);
  assert.match(body, /• Add the index/);
  assert.match(body, /• Backfill the column/);
  assert.match(body, /\$ psql -f m\.sql/, "the command that runs is part of the ask");
});

test("decisionLineFor prefers `summary`, and NEVER returns the preview", () => {
  assert.equal(decisionLineFor({ summary: "Do X", preview: WALL_OF_TEXT } as never), "Do X");
  const noSummary = decisionLineFor({ type: "db_health_build", preview: WALL_OF_TEXT } as never);
  assert.ok(!noSummary.includes("Signature"), "the preview must never become the decision line");
});

test("an action with no summary/preview still produces a usable card (no empty body)", () => {
  const bare = {
    ...(job as unknown as Record<string, unknown>),
    log_tail: "worker log fallback",
    pending_actions: [{ id: "a1", type: "db_health_build", status: "pending" }],
  } as unknown as typeof job;
  const { body } = buildApprovalContent(bare);
  assert.ok(body.trim().length > 0);
  assert.match(body, /db_health_build/);
});

test("the evidence cap is the documented constant", () => {
  assert.equal(typeof APPROVAL_EVIDENCE_MAX, "number");
  assert.ok(APPROVAL_EVIDENCE_MAX < 4000, "evidence must not be able to fill the whole card");
});
