/**
 * `tickets-awaiting-handler-dispatch` work-probe / dispatch-intent alignment pin — spec
 * docs/brain/specs/control-tower-unified-handler-dispatch-workprobe.md (Phase 1).
 *
 * The Control Tower's `loop:unified-ticket-handler` tile used to reuse `tickets-awaiting-decision`,
 * which counts inbound customer messages that DRIVE the per-ticket decision agent
 * (callSonnetOrchestratorV2). That surface is a superset of what the handler is actually meant to
 * claim — a raw inbound row that was NOT stamped by `dispatchInboundMessage` (because its ingest
 * path deliberately bypassed the handler — CSAT-reopen inserts, sentinel merges) still counted as
 * handler work and could fire idle_while_work on a quiet-window inbound the handler never should
 * have invoked at all.
 *
 * The durable fix (learning #14 — change the durable predicate, not the timestamp): key the
 * probe on the handler's OWN signal — `ticket_messages.dispatch_pending_at` set on the row by
 * `dispatchInboundMessage` and cleared by `clearDispatchIntent` at the top of every claimed
 * handler run. An aged un-cleared stamp is an unambiguous LOST handler dispatch — the exact class
 * loop:unified-ticket-handler is supposed to alert on. Non-dispatched raw inbounds carry NO stamp
 * and are NOT counted, so the tile can no longer false-page on them.
 *
 * These pins catch a refactor that drops the fingerprint or lets the probe drift off the
 * backstop cron's settle window (`INTENT_SETTLE_MS`).
 *
 * Run: npx tsx --test src/lib/control-tower/tickets-awaiting-handler-dispatch-workprobe.regression.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MONITORED_LOOPS } from "./registry";

const MONITOR = "src/lib/control-tower/monitor.ts";
const REGISTRY = "src/lib/control-tower/registry.ts";
const BACKSTOP = "src/lib/inngest/unanswered-inbound-backstop-cron.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf-8");
}

/**
 * Extract the `case "tickets-awaiting-handler-dispatch": { ... }` block from monitor.ts so a
 * matcher on it can't drift into a neighbouring case (each work-signal case has its own filters).
 */
function handlerDispatchBlock(src: string): string {
  const m = src.match(/case\s+"tickets-awaiting-handler-dispatch":\s*\{([\s\S]*?)\n\s*\}\s*\n\s*(?:case\s+"|default)/);
  assert.ok(m, "tickets-awaiting-handler-dispatch case block not found in monitor.ts — did the switch shape change?");
  return m[1];
}

// ── Handler tile is wired to the dispatch probe ──────────────────────────────

test("MONITORED_LOOPS unified-ticket-handler row uses the tickets-awaiting-handler-dispatch inlineWorkSignal", () => {
  const handler = MONITORED_LOOPS.find((l) => l.id === "unified-ticket-handler");
  assert.ok(handler, "unified-ticket-handler MONITORED_LOOPS entry must exist — the Inbound ticket handler tile is the point of the split-probe spec.");
  assert.equal(
    handler!.inlineWorkSignal,
    "tickets-awaiting-handler-dispatch",
    "unified-ticket-handler must probe `tickets-awaiting-handler-dispatch` — reusing `tickets-awaiting-decision` (the AI-orchestrator's demand surface) manufactured false idle_while_work alerts on raw inbounds the handler was never supposed to service. See control-tower-unified-handler-dispatch-workprobe.",
  );
});

test("MONITORED_LOOPS ai:orchestrator entry keeps `tickets-awaiting-decision` — the orchestrator tile is unchanged", () => {
  const orch = MONITORED_LOOPS.find((l) => l.id === "ai:orchestrator");
  assert.ok(orch, "ai:orchestrator MONITORED_LOOPS entry must exist — the per-ticket decision agent tile is the other half of the split-probe spec.");
  assert.equal(
    orch!.inlineWorkSignal,
    "tickets-awaiting-decision",
    "ai:orchestrator must keep probing `tickets-awaiting-decision` — the handler and the orchestrator are different loops with different upstream contracts, so splitting the handler probe onto `tickets-awaiting-handler-dispatch` MUST leave the orchestrator on the decision-demand probe. If this drifts, both tiles collapse to the same alert surface and the split is undone.",
  );
});

// ── The handler-specific work probe fingerprint exists in the monitor implementation ─────────

test("tickets-awaiting-handler-dispatch probe queries ticket_messages for un-cleared dispatch_pending_at", () => {
  const block = handlerDispatchBlock(read(MONITOR));
  assert.match(
    block,
    /\.from\(\s*"ticket_messages"\s*\)/,
    "`tickets-awaiting-handler-dispatch` probe must query the ticket_messages table — the handler's dispatch intent lives on that row (dispatch_pending_at), not on tickets or agent_jobs.",
  );
  assert.match(
    block,
    /\.not\(\s*"dispatch_pending_at"\s*,\s*"is"\s*,\s*null\s*\)/,
    "`tickets-awaiting-handler-dispatch` probe must call .not('dispatch_pending_at', 'is', null) — an un-cleared stamp is the entire signal (dispatchInboundMessage sets it, clearDispatchIntent clears it). Without this filter the count includes rows the handler already claimed, defeating the point of the split.",
  );
  assert.match(
    block,
    /\.lte\(\s*"dispatch_pending_at"\s*,/,
    "`tickets-awaiting-handler-dispatch` probe must apply an age cutoff via .lte('dispatch_pending_at', cutoff) — a fresh stamp still inside the Inngest delivery window would false-fire idle_while_work on healthy traffic without this settle grace.",
  );
});

test("tickets-awaiting-handler-dispatch probe filters to inbound customer messages", () => {
  const block = handlerDispatchBlock(read(MONITOR));
  assert.match(
    block,
    /\.eq\(\s*"direction"\s*,\s*"inbound"\s*\)/,
    "`tickets-awaiting-handler-dispatch` probe must filter direction='inbound' — the handler services inbound customer messages, so counting outbound rows that somehow carry the column would leak into the alert surface.",
  );
  assert.match(
    block,
    /\.eq\(\s*"author_type"\s*,\s*"customer"\s*\)/,
    "`tickets-awaiting-handler-dispatch` probe must filter author_type='customer' — the dispatch stamp only ever applies to customer-authored inbounds; pinning the filter matches the semantic so a future outbound-side use of the column can't accidentally leak into the count.",
  );
});

test("tickets-awaiting-handler-dispatch probe uses the HANDLER_DISPATCH_SETTLE_MS boundary", () => {
  const block = handlerDispatchBlock(read(MONITOR));
  assert.match(
    block,
    /HANDLER_DISPATCH_SETTLE_MS/,
    "`tickets-awaiting-handler-dispatch` probe must key its cutoff on HANDLER_DISPATCH_SETTLE_MS — a hard-coded ms literal in the case body silently drifts from the backstop cron's INTENT_SETTLE_MS mirror.",
  );
});

// ── Non-dispatched raw inbounds are not counted for the handler ────────────
// This is what the spec explicitly asks for. The dispatch_pending_at filter is the CONSTRUCTION
// that makes it true: only rows that went through `dispatchInboundMessage` carry a stamp; every
// raw inbound path that bypasses it (CSAT-reopen inserts, sentinel merges) leaves the column NULL,
// so `.not('dispatch_pending_at', 'is', null)` structurally excludes them from the count.

test("non-dispatched raw inbounds are excluded structurally — no author-type or channel bypass logic in the case", () => {
  const block = handlerDispatchBlock(read(MONITOR));
  // The old probe (tickets-awaiting-decision) had to subtract several bypass classes because it
  // counted every inbound customer message as work. The dispatch probe doesn't need those
  // subtractions — the `dispatch_pending_at` filter is the structural inclusion criterion, and a
  // non-dispatched raw inbound simply doesn't match. Assert the case body does NOT reintroduce a
  // secondary count-subtract-count pattern that would over-count and re-open the false-positive.
  assert.doesNotMatch(
    block,
    /ticket_resolution_events/,
    "`tickets-awaiting-handler-dispatch` case must NOT join ticket_resolution_events — the dispatch-intent probe is inclusion-only (a stamp is present or it isn't). Reintroducing an ack-ledger subtraction resurrects the tickets-awaiting-decision architecture the split is designed to leave behind.",
  );
  assert.doesNotMatch(
    block,
    /extractSolHandleBypassTicketIds/,
    "`tickets-awaiting-handler-dispatch` case must NOT reuse the Sol bypass-ticket-id extraction — Sol first-touch/inflection dispatches happen ON TOP of the handler run (unified-ticket-handler / reSessionSol enqueue them mid-run), so a message that reached the handler has already had its stamp cleared and never enters this count. The subtraction is meaningless here and adding it re-couples the handler tile to the orchestrator's bypass classes.",
  );
});

// ── Aged unclaimed dispatch intents are counted ────────────────────────────

test("aged unclaimed dispatch intents fingerprint — probe reads dispatch_pending_at with a lte cutoff derived from Date.now() - HANDLER_DISPATCH_SETTLE_MS", () => {
  const block = handlerDispatchBlock(read(MONITOR));
  // The cutoff has to be derived at query time so 'aged' is a moving window (older than the
  // settle boundary), not a build-time constant. Pin the shape.
  assert.match(
    block,
    /Date\.now\(\s*\)\s*-\s*HANDLER_DISPATCH_SETTLE_MS/,
    "`tickets-awaiting-handler-dispatch` probe must derive its cutoff from `Date.now() - HANDLER_DISPATCH_SETTLE_MS` — a static cutoff would let a stale row age past the boundary without the tile reacting, defeating the settle-grace.",
  );
});

test("tickets-awaiting-handler-dispatch probe uses a head-count query (no row fetch)", () => {
  const block = handlerDispatchBlock(read(MONITOR));
  assert.match(
    block,
    /count:\s*"exact"\s*,\s*head:\s*true/,
    "`tickets-awaiting-handler-dispatch` probe must use `{ count: 'exact', head: true }` — the probe only needs the number of aged un-cleared stamps, not the rows themselves. Pulling rows would scale the probe cost per inbound-message rate without changing the outcome.",
  );
});

// ── Drift pin: monitor's settle constant matches the backstop cron's INTENT_SETTLE_MS ─────────

test("monitor's HANDLER_DISPATCH_SETTLE_MS matches unanswered-inbound-backstop-cron.INTENT_SETTLE_MS", () => {
  // The monitor defines HANDLER_DISPATCH_SETTLE_MS locally (to avoid pulling an
  // inngest.createFunction module into the control-tower import graph). If the cron's
  // INTENT_SETTLE_MS is ever changed, the local mirror must move in lock-step or the probe and
  // the reconciler silently disagree on what "aged" means — the tile alerts on rows the
  // reconciler hasn't yet re-fired, or vice versa.
  const monitor = read(MONITOR);
  const cron = read(BACKSTOP);
  const monitorMatch = monitor.match(/HANDLER_DISPATCH_SETTLE_MS\s*=\s*([^;]+);/);
  assert.ok(monitorMatch, "monitor.ts must define HANDLER_DISPATCH_SETTLE_MS = <expr>;");
  const cronMatch = cron.match(/INTENT_SETTLE_MS\s*=\s*([^;]+);/);
  assert.ok(cronMatch, "unanswered-inbound-backstop-cron.ts must define INTENT_SETTLE_MS = <expr>;");
  const monitorMs = Function(`"use strict"; return (${monitorMatch[1]});`)() as number;
  const cronMs = Function(`"use strict"; return (${cronMatch[1]});`)() as number;
  assert.equal(
    monitorMs,
    cronMs,
    "HANDLER_DISPATCH_SETTLE_MS in monitor.ts must equal INTENT_SETTLE_MS in unanswered-inbound-backstop-cron.ts — the probe and the reconciler MUST see the same 'aged' window, or one flips the tile red while the other has already handled the row (or vice versa).",
  );
});

// ── Signal id is registered ────────────────────────────────────────────────

test("registry.ts declares tickets-awaiting-handler-dispatch in the InlineWorkSignalId union", () => {
  const registry = read(REGISTRY);
  // Union declaration only — matches `| "tickets-awaiting-handler-dispatch"` at the top-level type.
  assert.match(
    registry,
    /InlineWorkSignalId\s*=[\s\S]*?\|\s*"tickets-awaiting-handler-dispatch"/,
    "registry.ts must declare `tickets-awaiting-handler-dispatch` in the InlineWorkSignalId type — MonitoredLoop rows carrying it wouldn't typecheck otherwise.",
  );
});
