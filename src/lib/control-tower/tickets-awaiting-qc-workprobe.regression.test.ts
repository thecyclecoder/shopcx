/**
 * `tickets-awaiting-qc` work-probe / cron alignment pin — Fix 1 of spec
 * docs/brain/specs/journey-completion-stamps-closed-at-so-cora-can-grade.md.
 *
 * The Control Tower's `ai:ticket-analyzer` loop compares upstream demand (the work probe below)
 * against the ticket-analysis cron's actual heartbeats. If the probe counts tickets the cron
 * CANNOT select (closed_at IS NULL, sol_handled_at IS NULL — the exact origin bug of this spec:
 * a journey completion route shipped status='closed'+resolved_at but no closed_at, so the
 * ticket looks closed to the probe but is invisible to the cron), the probe reports "work
 * waiting" while the cron logs zero successful runs, and the monitor opens a false
 * `idle_while_work` loop_alert — Cora's tile goes red on a healthy analyzer.
 *
 * The durable fix (learning #1 — change the predicate, not the timestamp) is to mirror the
 * cron's real selection universe in the probe: same `.not("closed_at", "is", null)` +
 * `.not("sol_handled_at", "is", null)` gates the cron's `find-tickets` query applies at
 * src/lib/inngest/ticket-analysis-cron.ts. A source-inspection pin here catches a refactor
 * that drops either gate — the probe and the cron MUST see the same universe of work
 * (standing pattern; see the sibling comment in monitor.ts).
 *
 * Run: npx tsx --test src/lib/control-tower/tickets-awaiting-qc-workprobe.regression.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MONITOR = "src/lib/control-tower/monitor.ts";
const CRON = "src/lib/inngest/ticket-analysis-cron.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf-8");
}

/** Extract the `case "tickets-awaiting-qc": { ... }` block from monitor.ts so a matcher on
 *  it can't drift into a neighbouring case (each work-signal case has its own filters). */
function ticketsAwaitingQcBlock(src: string): string {
  const m = src.match(/case\s+"tickets-awaiting-qc":\s*\{([\s\S]*?)\n\s*\}\s*\n\s*case\s+"/);
  assert.ok(m, "tickets-awaiting-qc case block not found in monitor.ts — did the switch shape change?");
  return m[1];
}

test("tickets-awaiting-qc work probe requires closed_at IS NOT NULL (cron-selection mirror)", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  assert.match(
    block,
    /\.not\(\s*"closed_at"\s*,\s*"is"\s*,\s*null\s*\)/,
    "`tickets-awaiting-qc` work probe must call .not('closed_at', 'is', null) — the ticket-analysis-cron's find-tickets query requires closed_at IS NOT NULL, so counting closed_at-null tickets as awaited work manufactures a false idle_while_work on loop:ai:ticket-analyzer (the origin bug this spec repairs).",
  );
});

test("tickets-awaiting-qc work probe requires sol_handled_at IS NOT NULL (cron-selection mirror)", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  assert.match(
    block,
    /\.not\(\s*"sol_handled_at"\s*,\s*"is"\s*,\s*null\s*\)/,
    "`tickets-awaiting-qc` work probe must call .not('sol_handled_at', 'is', null) — the ticket-analysis-cron's find-tickets query requires sol_handled_at IS NOT NULL (Sol-handled signal), so counting sol_handled_at-null tickets as awaited work manufactures a false idle_while_work on loop:ai:ticket-analyzer.",
  );
});

test("ticket-analysis cron continues to require closed_at + sol_handled_at at the source (probe target)", () => {
  // Sanity — if the cron's own gate is ever relaxed to select null-closed_at / null-sol_handled_at
  // rows, the probe's added filters would legitimately need re-thinking. Pin the cron's gate too
  // so a relaxation red-lights this test with a clear message.
  const cron = read(CRON);
  assert.match(
    cron,
    /\.not\(\s*"closed_at"\s*,\s*"is"\s*,\s*null\s*\)/,
    "ticket-analysis-cron find-tickets must keep closed_at IS NOT NULL — if this is relaxed the probe's cron-selection-mirror comment is stale.",
  );
  assert.match(
    cron,
    /\.not\(\s*"sol_handled_at"\s*,\s*"is"\s*,\s*null\s*\)/,
    "ticket-analysis-cron find-tickets must keep sol_handled_at IS NOT NULL — if this is relaxed the probe's cron-selection-mirror comment is stale.",
  );
});
