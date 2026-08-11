/**
 * `ceoEscalationNotification` must carry the CALLER'S metadata onto the card — above all `job_id`.
 *
 * The regression (2026-08-11): the builder's parameter type had no `metadata` field and its returned
 * object never spread one, while `escalateDiagnosisToCeo` accepted `metadata` and passed its whole
 * `args` object in. `args` is a variable, not an object literal, so TypeScript's excess-property
 * check never fired and every caller's context was silently dropped. The ledger got it; the card
 * did not.
 *
 * Two live bugs followed, both of which cost real founder time:
 *   1. `activeParkCardExistsForJob` looks cards up by `metadata.job_id` / `agent_job_id`. No
 *      escalation card had either, so the one-card-per-park DEDUPE always said "no card exists" and
 *      every emitter minted its own — the duplicate fan-out.
 *   2. `reconcileStaleParkCards` Family 1 partitions on `notifJobId`, so escalation cards were never
 *      evaluated — including the branch that dismisses a park card once its PR is MERGED. A card for
 *      an already-merged PR became structurally unclearable (`pr-2438`, `pr-2450`).
 *
 * These assertions are static-analysis on the source: the builder is module-private, and importing
 * the module to call it drags in the full director dependency graph.
 *
 *   npx tsx --test src/lib/agents/platform-director.escalation-metadata.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./platform-director.ts", import.meta.url), "utf8");
const BUILDER = SRC.slice(
  SRC.indexOf("function ceoEscalationNotification"),
  SRC.indexOf("function ceoEscalationNotification") + 4000,
);

test("the builder ACCEPTS a metadata parameter", () => {
  const sig = BUILDER.slice(0, BUILDER.indexOf("}) {"));
  assert.match(sig, /metadata\?:\s*Record<string,\s*unknown>/, "ceoEscalationNotification must accept caller metadata");
});

test("the builder SPREADS caller metadata onto the card", () => {
  assert.match(BUILDER, /\.\.\.\(args\.metadata \?\? \{\}\)/, "caller metadata must be spread onto the notification");
});

test("caller metadata is spread BEFORE the canonical fields, so routing cannot be spoofed", () => {
  const spreadAt = BUILDER.indexOf("...(args.metadata ?? {})");
  const routedAt = BUILDER.indexOf("routed_to_function: CEO");
  const kindAt = BUILDER.indexOf("escalation_kind: args.escalationKind");
  const dedupeAt = BUILDER.indexOf("dedupe_key: args.dedupeKey");
  assert.ok(spreadAt > 0 && routedAt > 0 && kindAt > 0 && dedupeAt > 0, "all anchors present");
  assert.ok(spreadAt < routedAt, "routed_to_function must win over caller metadata");
  assert.ok(spreadAt < kindAt, "escalation_kind must win over caller metadata");
  assert.ok(spreadAt < dedupeAt, "dedupe_key must win over caller metadata");
});

test("the park emitters still PASS job_id — the other half of the contract", () => {
  // If a caller stops sending job_id, the card silently loses its lifecycle again. Pin the two
  // highest-traffic park emitters.
  const route = readFileSync(new URL("./needs-attention-route.ts", import.meta.url), "utf8");
  assert.match(route, /escalationKind:\s*"park_backstop"[\s\S]{0,200}job_id:\s*row\.id/, "the backstop must pass job_id");
  assert.match(SRC, /escalationKind:\s*"needs_attention"[\s\S]{0,300}job_id:\s*j\.id/, "the triage park must pass job_id");
});
