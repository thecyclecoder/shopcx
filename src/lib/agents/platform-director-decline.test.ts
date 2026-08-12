/**
 * Unit tests for `applyDirectorDecline` + the `decline` verdict in Ada's investigation prompt —
 * a-director-who-can-approve-can-decline (2026-08-11).
 *
 * THE GAP THIS PINS. Ada's verdict vocabulary was `auto-approve` | `bounce` (repair only) | `escalate`.
 * There was no way to say NO. So when she investigated an IN-LEASH request and concluded it should not
 * run — a duplicate of already-shipped work, a no-op that would build nothing and park — her only legal
 * move was `escalate`, which put a fully-reasoned "don't do this" in the CEO inbox as a decision he still
 * had to make. Live case: db_health slow-query signature `-1756037457588317045` produced FIVE CEO cards
 * (four already dismissed), each carrying Ada's own several-hundred-word explanation of why the proposal
 * was the fifth duplicate of four already-shipped fixes. The founder's job was to click Decline on a call
 * Ada had already made.
 *
 * Run:  npx tsx --test src/lib/agents/platform-director-decline.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyDirectorDecline, directorInvestigationPrompt, buildDirectorBrief } from "./platform-director";

type Row = Record<string, unknown>;

/** Minimal admin stub: captures the agent_jobs patch + any approval_decisions insert. */
function fakeAdmin() {
  const captured: { jobPatch: Row | null; decision: Row | null } = { jobPatch: null, decision: null };
  const admin = {
    from(table: string) {
      if (table === "agent_jobs") {
        return {
          update(patch: Row) {
            captured.jobPatch = patch;
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      // approval_decisions (and anything else) — swallow the insert, record it.
      return {
        insert(row: Row) {
          captured.decision = row;
          return { select: () => ({ single: async () => ({ data: { id: "d1" }, error: null }),
                                    maybeSingle: async () => ({ data: { id: "d1" }, error: null }) }) };
        },
        update() { return { eq: async () => ({ error: null }) }; },
        select() { return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }; },
      };
    },
  };
  return { admin, captured };
}

const target = {
  id: "job-1",
  workspace_id: "ws-1",
  kind: "db_health",
  spec_slug: "dbhealth:slowq:-1756037457588317045",
  pending_actions: [{ id: "a1", type: "db_health_build", status: "pending" }],
} as unknown as Parameters<typeof applyDirectorDecline>[1];

test("declining marks the action `declined` — never `approved`", async () => {
  const { admin, captured } = fakeAdmin();
  const res = await applyDirectorDecline(admin as never, target, "a1", "already shipped 4x — this is a no-op");
  assert.equal(res.ok, true);
  const actions = (captured.jobPatch?.pending_actions ?? []) as Row[];
  assert.equal(actions[0].status, "declined");
});

test("a fully-declined request goes TERMINAL as `dismissed` — it must not resume and execute", async () => {
  // The whole point: nothing runs. `queued_resume` here would execute the very action Ada rejected.
  const { admin, captured } = fakeAdmin();
  await applyDirectorDecline(admin as never, target, "a1", "no-op");
  assert.equal(captured.jobPatch?.status, "dismissed");
  assert.notEqual(captured.jobPatch?.status, "queued_resume");
});

test("a bundle with an action still pending does NOT go terminal (all-or-nothing is preserved)", async () => {
  const twoActions = {
    ...(target as unknown as Row),
    pending_actions: [
      { id: "a1", type: "db_health_build", status: "pending" },
      { id: "a2", type: "db_health_build", status: "pending" },
    ],
  } as unknown as Parameters<typeof applyDirectorDecline>[1];
  const { admin, captured } = fakeAdmin();
  await applyDirectorDecline(admin as never, twoActions, "a1", "only one declined");
  assert.equal(captured.jobPatch?.status, undefined, "status untouched while another action is still pending");
});

test("the decision is recorded as `declined` on the ledger, so the grader scores the call", async () => {
  const { admin, captured } = fakeAdmin();
  await applyDirectorDecline(admin as never, target, "a1", "duplicate of #1551/#1904/#1963/#2151");
  assert.equal(captured.decision?.decision, "declined");
  assert.equal(captured.decision?.decided_by, "director");
  assert.match(String(captured.decision?.reasoning ?? ""), /duplicate/);
});

test("the prompt OFFERS decline, and tells Ada it is hers rather than an escalation", () => {
  const prompt = directorInvestigationPrompt({
    jobId: "j", kind: "db_health", specSlug: "s", categories: ["db_health"],
    actions: [{ category: "db_health", summary: "s", preview: "p", cmd: "", specBody: "" }],
    multi: false, logTail: "",
  });
  assert.match(prompt, /"verdict":"decline"/, "decline must be an offered verdict");
  assert.match(prompt, /DECLINE IS YOURS TO MAKE/i);
  // The specific anti-pattern that produced the five CEO cards.
  assert.match(prompt, /Do NOT escalate a request just to have the CEO click Decline/i);
});

test("the prompt still refuses rubber-stamping (the safety half is unchanged)", () => {
  const prompt = directorInvestigationPrompt({
    jobId: "j", kind: "db_health", specSlug: "s", categories: ["db_health"],
    actions: [{ category: "db_health", summary: "s", preview: "p", cmd: "", specBody: "" }],
    multi: false, logTail: "",
  });
  assert.match(prompt, /NEVER rubber-stamp/i);
  assert.match(prompt, /ALWAYS ESCALATE \(never auto-approve\)/i);
});

// ── the-brief-must-carry-the-proposal (2026-08-11) ──────────────────────────────────────────
// db_health puts its ENTIRE proposal — diagnosed cause, pg_stat_statements row, EXPLAIN plan,
// phase plan — on `pending_actions[].spec_body`, leaving summary/preview/cmd null. The brief read
// only those three, so Ada got a structurally EMPTY brief for a 2,464-char proposal and correctly
// refused to approve what she could not see. Every db_health proposal escalated to the CEO for
// "I cannot confirm this is sound" — a missing field, not a judgment failure.
// Live: dbhealth:slowq:4608471940106465663:specs, card 2026-08-11T17:33Z.

test("buildDirectorBrief carries `spec_body` — a db_health action is no longer an empty brief", () => {
  const job = {
    id: "j1",
    workspace_id: "ws",
    kind: "db_health",
    spec_slug: "dbhealth:slowq:4608471940106465663:specs",
    log_tail: "seq scan on specs · 91ms mean × 26677 calls",
    pending_actions: [
      { id: "a1", type: "db_health_build", status: "pending", spec_body: "# Add an index\n\nEXPLAIN:\nSeq Scan on specs" },
    ],
  } as unknown as Parameters<typeof buildDirectorBrief>[0];
  const brief = buildDirectorBrief(job, [{ actionId: "a1", category: "db_health" }] as never);
  assert.equal(brief.actions[0].specBody, "# Add an index\n\nEXPLAIN:\nSeq Scan on specs");
  assert.equal(brief.actions[0].summary, "", "summary really is empty — the body is the content");
});

test("the prompt RENDERS the pre-authored body, so the EXPLAIN is readable", () => {
  const prompt = directorInvestigationPrompt({
    jobId: "j", kind: "db_health", specSlug: "s", categories: ["db_health"],
    actions: [{ category: "db_health", summary: "", preview: "", cmd: "", specBody: "EXPLAIN:\nSeq Scan on specs (rows=132)" }],
    multi: false, logTail: "",
  });
  assert.match(prompt, /PRE-AUTHORED SPEC BODY/);
  assert.match(prompt, /Seq Scan on specs \(rows=132\)/, "the evidence must reach the prompt verbatim");
});

test("a db_health brief tells Ada how to judge an index proposal from the plan", () => {
  const prompt = directorInvestigationPrompt({
    jobId: "j", kind: "db_health", specSlug: "s", categories: ["db_health"],
    actions: [{ category: "db_health", summary: "", preview: "", cmd: "", specBody: "EXPLAIN: Seq Scan" }],
    multi: false, logTail: "",
  });
  assert.match(prompt, /READ THE PLAN before deciding/i);
  assert.match(prompt, /non-sargable/i, "the OR/CASE case must be named — it is why the live proposal was unsound");
  assert.match(prompt, /already covered by an existing index/i);
});

test("a non-db_health brief does NOT get the index guidance (no prompt bloat)", () => {
  const prompt = directorInvestigationPrompt({
    jobId: "j", kind: "repair", specSlug: "s", categories: ["error_fix"],
    actions: [{ category: "error_fix", summary: "fix", preview: "p", cmd: "", specBody: "" }],
    multi: false, logTail: "",
  });
  assert.ok(!/READ THE PLAN before deciding/i.test(prompt));
});

test("an action with no spec_body renders no empty section", () => {
  const prompt = directorInvestigationPrompt({
    jobId: "j", kind: "repair", specSlug: "s", categories: ["error_fix"],
    actions: [{ category: "error_fix", summary: "fix", preview: "p", cmd: "", specBody: "" }],
    multi: false, logTail: "",
  });
  assert.ok(!/PRE-AUTHORED SPEC BODY/.test(prompt));
});
