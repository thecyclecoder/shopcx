/**
 * Unit tests for Sol's Phase-2 dual-output helper — [[./sol-proposed-spec]].
 *
 * Verifies the exact Phase-2 verification bullet:
 *   "A portal error with a structural cause produces BOTH a customer-facing resolution action AND a
 *    proposed ticket-derived spec (owner=cs, Derived-from-ticket) on the Roadmap; a one-off portal
 *    error produces only the customer fix and no spec."
 *
 * We test the pure helpers because they carry the artifact-visible shape (owner=cs, autoBuild=false,
 * Derived-from-ticket ref in summary, parent anchoring):
 *
 *   1. `validateSolProposedSpec` returns the normalized shape on complete input.
 *   2. `validateSolProposedSpec` returns `null` on the "one-off portal error" case (missing/empty
 *      fields, no `proposed_spec` field, non-string type) — so the worker's presence-check skips
 *      the spec author on that branch.
 *   3. `buildPortalErrorSpecFields` embeds the ticket-derived ref.
 *   4. `buildAuthorSpecArgs` returns owner='cs', autoBuild=false, summary carries Derived-from-ticket,
 *      and picks up a matched CS mandate slug as parent.
 *   5. An unknown mandate falls back to bare `[[../functions/cs]]` (chokepoint auto-anchors).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSolProposedSpec,
  buildPortalErrorSpecFields,
  buildAuthorSpecArgs,
} from "./sol-proposed-spec";
import type { FunctionMandate } from "@/lib/function-mandates";

const TID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const FULL_INPUT = {
  slug: "portal-freq-transient-400-swallowed",
  title: "Portal frequency-change swallows a transient 400",
  intent: "Prevent customers from seeing a portal frequency failure when Appstle returns a transient 400.",
  problem: "The frequency handler surfaces every non-200 as user-facing, including 'operation in progress' 400s that a short retry would resolve.",
  mandate: "escalation-triage-quality",
};

const CS_MANDATES: FunctionMandate[] = [
  {
    slug: "escalation-triage-quality",
    heading: "Escalation triage quality",
  } as FunctionMandate,
  {
    slug: "ticket-derived-product-fixes",
    heading: "Ticket-derived product fixes",
  } as FunctionMandate,
];

// ── validateSolProposedSpec ─────────────────────────────────────────────────

test("validateSolProposedSpec normalizes a complete proposed_spec", () => {
  const out = validateSolProposedSpec(FULL_INPUT);
  assert.ok(out, "structural cause → returns a spec");
  assert.equal(out?.slug, FULL_INPUT.slug);
  assert.equal(out?.title, FULL_INPUT.title);
  assert.equal(out?.intent, FULL_INPUT.intent);
  assert.equal(out?.problem, FULL_INPUT.problem);
  assert.equal(out?.mandate, FULL_INPUT.mandate);
});

test("validateSolProposedSpec kebab-sanitizes the slug", () => {
  const out = validateSolProposedSpec({ ...FULL_INPUT, slug: "  Portal Freq Bug 400!!  " });
  assert.ok(out);
  // Whitespace + `!!` → dashes, collapsed to single-dash runs, trimmed of leading/trailing dashes.
  assert.equal(out?.slug, "portal-freq-bug-400");
});

test("one-off portal error: missing proposed_spec field → null (no spec author)", () => {
  assert.equal(validateSolProposedSpec(undefined), null);
  assert.equal(validateSolProposedSpec(null), null);
  assert.equal(validateSolProposedSpec({}), null);
});

test("one-off portal error: missing required subfields → null", () => {
  const cases = [
    { ...FULL_INPUT, slug: "" },
    { ...FULL_INPUT, title: "" },
    { ...FULL_INPUT, intent: "" },
    { ...FULL_INPUT, problem: "" },
  ];
  for (const c of cases) {
    assert.equal(validateSolProposedSpec(c), null, `blank field → null (${JSON.stringify(c)})`);
  }
});

test("one-off portal error: wrong type → null", () => {
  assert.equal(validateSolProposedSpec("some string"), null);
  assert.equal(validateSolProposedSpec(42), null);
  assert.equal(validateSolProposedSpec({ ...FULL_INPUT, title: 123 }), null);
});

test("mandate omitted → mandate=null (chokepoint auto-anchors downstream)", () => {
  const { mandate, ...rest } = FULL_INPUT;
  void mandate;
  const out = validateSolProposedSpec(rest);
  assert.ok(out);
  assert.equal(out?.mandate, null);
});

// ── buildPortalErrorSpecFields ─────────────────────────────────────────────

test("buildPortalErrorSpecFields embeds the Derived-from-ticket ref in the summary", () => {
  const { summary, phaseBody, phaseVerification } = buildPortalErrorSpecFields(
    { intent: "test intent", problem: "test problem" },
    TID,
  );
  assert.match(summary, new RegExp(`\\*\\*Derived-from-ticket:\\*\\* \`${TID}\``));
  assert.match(summary, /test intent/);
  assert.match(summary, /test problem/);
  assert.match(summary, /## Problem \(from portal-error ticket/);
  assert.match(phaseBody, /Implement the fix/);
  assert.match(phaseVerification, /Reproduce the portal error/);
  assert.match(phaseVerification, new RegExp(`\`${TID}\``));
  assert.match(phaseVerification, /`npx tsc --noEmit` clean\./);
});

// ── buildAuthorSpecArgs ────────────────────────────────────────────────────

test("buildAuthorSpecArgs — owner=cs, autoBuild=false, summary carries Derived-from-ticket", () => {
  const spec = validateSolProposedSpec(FULL_INPUT);
  assert.ok(spec);
  const { slug, input, opts, matchedMandate } = buildAuthorSpecArgs(TID, spec!, CS_MANDATES);
  assert.equal(slug, FULL_INPUT.slug);
  assert.equal(input.owner, "cs");
  assert.equal(input.autoBuild, false, "planned on the Roadmap, not auto-built");
  assert.equal(input.title, FULL_INPUT.title);
  assert.match(input.summary || "", new RegExp(`\\*\\*Derived-from-ticket:\\*\\* \`${TID}\``));
  assert.equal(input.phases.length, 1);
  assert.equal(input.phases[0].status, "planned");
  assert.match(input.phases[0].title, /P1/);
  assert.equal(opts.intendedStatusSetBy, "box:sol-ticket-handle");
  // Verified matched mandate → typed parent anchoring.
  assert.equal(matchedMandate?.slug, "escalation-triage-quality");
  assert.equal(opts.parentKind, "mandate");
  assert.equal(opts.parentRef, "cs#escalation-triage-quality");
  assert.match(input.parent, /\[\[\.\.\/functions\/cs#escalation-triage-quality\]\]/);
});

test("buildAuthorSpecArgs — unknown mandate falls back to bare `[[../functions/cs]]`", () => {
  const spec = validateSolProposedSpec({ ...FULL_INPUT, mandate: "does-not-exist" });
  assert.ok(spec);
  const { input, opts, matchedMandate } = buildAuthorSpecArgs(TID, spec!, CS_MANDATES);
  assert.equal(matchedMandate, null);
  assert.equal(opts.parentKind, null);
  assert.equal(opts.parentRef, null);
  assert.equal(input.parent, "[[../functions/cs]]");
});

test("buildAuthorSpecArgs — mandate omitted → same bare-function parent", () => {
  const spec = validateSolProposedSpec({ ...FULL_INPUT, mandate: undefined });
  assert.ok(spec);
  const { input, opts, matchedMandate } = buildAuthorSpecArgs(TID, spec!, CS_MANDATES);
  assert.equal(matchedMandate, null);
  assert.equal(opts.parentKind, null);
  assert.equal(input.parent, "[[../functions/cs]]");
});
