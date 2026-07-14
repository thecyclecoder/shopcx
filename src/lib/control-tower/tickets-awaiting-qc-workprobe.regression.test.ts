/**
 * `tickets-awaiting-qc` work-probe / cron alignment pin — Fix 1 of spec
 * docs/brain/specs/journey-completion-stamps-closed-at-so-cora-can-grade.md, extended by
 * docs/brain/specs/ticket-analyzer-workprobe-last-customer-settle-grace.md (settle-window mirror).
 *
 * The Control Tower's `ai:ticket-analyzer` loop compares upstream demand (the work probe below)
 * against the ticket-analysis cron's actual heartbeats. If the probe counts tickets the cron
 * CANNOT select (closed_at IS NULL, sol_handled_at IS NULL — the exact origin bug of the first
 * spec: a journey completion route shipped status='closed'+resolved_at but no closed_at, so the
 * ticket looks closed to the probe but is invisible to the cron; OR the customer's last message
 * hasn't yet cleared Cora's 30-min settle window — the origin of the settle-grace spec), the
 * probe reports "work waiting" while the cron logs zero successful runs, and the monitor opens
 * a false `idle_while_work` loop_alert — Cora's tile goes red on a healthy analyzer.
 *
 * The durable fix (learning #1 — change the predicate, not the timestamp) is to mirror the
 * cron's real selection universe in the probe: same `.not("closed_at", "is", null)` +
 * `.not("sol_handled_at", "is", null)` gates the cron's `find-tickets` query applies at
 * src/lib/inngest/ticket-analysis-cron.ts, AND the same `passesCoraSelectionGate` settle keyed
 * on the LATEST CUSTOMER MESSAGE plus the feeder-cycle grace. Source-inspection pins here catch
 * a refactor that drops any of these — the probe and the cron MUST see the same universe of
 * work (standing pattern; see the sibling comment in monitor.ts).
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

test("ticket-analysis cron continues to require closed_at + a handled-ticket signal at the source (probe target)", () => {
  // Sanity — if the cron's own gate is ever relaxed to select null-closed_at rows or to drop the
  // handled-ticket signal entirely, the probe's added filters would legitimately need re-thinking.
  // Pin the cron's gate here so a relaxation red-lights this test with a clear message. The
  // handled-ticket signal is expressed as `.or("ai_handled_at.not.is.null,sol_handled_at.not.is.null")`
  // in the cron today (cora-grades-every-ai-handled-ticket-not-just-sol) — either stamp counts —
  // so we pin BOTH column names appearing under a `.or(...)`-shaped clause rather than a bare
  // `.not("sol_handled_at", "is", null)` (that older strict shape is the probe's, not the cron's).
  const cron = read(CRON);
  assert.match(
    cron,
    /\.not\(\s*"closed_at"\s*,\s*"is"\s*,\s*null\s*\)/,
    "ticket-analysis-cron find-tickets must keep closed_at IS NOT NULL — if this is relaxed the probe's cron-selection-mirror comment is stale.",
  );
  assert.match(
    cron,
    /\.or\(\s*"[^"]*ai_handled_at\.not\.is\.null[^"]*sol_handled_at\.not\.is\.null[^"]*"\s*\)/,
    "ticket-analysis-cron find-tickets must keep the handled-ticket OR clause requiring ai_handled_at OR sol_handled_at NOT NULL — if this is relaxed the probe's cron-selection-mirror comment is stale.",
  );
});

// ── ticket-analyzer-workprobe-last-customer-settle-grace ─────────────────────────────────────
// Pin the settle-window mirror: the probe must derive the latest customer message per candidate
// (`ticket_messages` + `author_type='customer'`), require its presence, and apply the combined
// CORA_CLOSE_SETTLE_MS + TICKET_ANALYSIS_FEEDER_GRACE_MS cutoff. Without these pins, a refactor
// could silently drop the settle-window mirror and re-open the false-alert window the spec was
// designed to close.

test("tickets-awaiting-qc probe queries ticket_messages for the latest customer message", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  assert.match(
    block,
    /\.from\(\s*"ticket_messages"\s*\)/,
    "`tickets-awaiting-qc` probe must query the ticket_messages table — the cron's real settle key is the LATEST CUSTOMER MESSAGE (passesCoraSelectionGate keys on `last_customer_message_at`), and the probe must mirror that or a false idle_while_work fires while the cron is deliberately waiting on the settle window.",
  );
  assert.match(
    block,
    /\.eq\(\s*"author_type"\s*,\s*"customer"\s*\)/,
    "`tickets-awaiting-qc` probe must filter ticket_messages on author_type='customer' — the cron settles on the last CUSTOMER message specifically (not an internal note or an outbound send), so the probe's reduction has to filter the same way.",
  );
});

test("tickets-awaiting-qc probe uses the combined Cora settle + feeder grace cutoff", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  // Combined settle-plus-feeder fingerprint. The exact identifiers guard against a partial
  // refactor that drops either the settle or the feeder half — both are required for the
  // cutoff to match the cron's real eligibility gate.
  assert.match(
    block,
    /TICKET_ANALYSIS_CORA_SETTLE_MS[\s\S]*TICKET_ANALYSIS_FEEDER_GRACE_MS|TICKET_ANALYSIS_FEEDER_GRACE_MS[\s\S]*TICKET_ANALYSIS_CORA_SETTLE_MS/,
    "`tickets-awaiting-qc` probe must combine TICKET_ANALYSIS_CORA_SETTLE_MS + TICKET_ANALYSIS_FEEDER_GRACE_MS into the last-customer-message cutoff — mirrors the cron's CORA_CLOSE_SETTLE_MS gate plus the existing feeder-cycle grace so a between-tick wait stays green and a genuinely-stuck analyzer still trips.",
  );
});

test("monitor's Cora settle constant matches ticket-analysis-cron.CORA_CLOSE_SETTLE_MS", () => {
  // A drift pin: the monitor defines TICKET_ANALYSIS_CORA_SETTLE_MS locally (to avoid pulling
  // an inngest.createFunction module into the control-tower import graph). If the cron's
  // CORA_CLOSE_SETTLE_MS is ever changed, the local mirror must move in lock-step or the probe
  // will silently diverge from the cron again. Pin both source expressions here so a change to
  // one without the other red-lights this test.
  const monitor = read(MONITOR);
  const cron = read(CRON);
  const monitorMatch = monitor.match(/TICKET_ANALYSIS_CORA_SETTLE_MS\s*=\s*([^;]+);/);
  assert.ok(monitorMatch, "monitor.ts must define TICKET_ANALYSIS_CORA_SETTLE_MS = <expr>;");
  const cronMatch = cron.match(/CORA_CLOSE_SETTLE_MS\s*=\s*([^;]+);/);
  assert.ok(cronMatch, "ticket-analysis-cron.ts must define CORA_CLOSE_SETTLE_MS = <expr>;");
  const monitorMs = Function(`"use strict"; return (${monitorMatch[1]});`)() as number;
  const cronMs = Function(`"use strict"; return (${cronMatch[1]});`)() as number;
  assert.equal(
    monitorMs,
    cronMs,
    "TICKET_ANALYSIS_CORA_SETTLE_MS in monitor.ts must equal CORA_CLOSE_SETTLE_MS in ticket-analysis-cron.ts — the probe and the cron must see the same settle window or the between-tick false alert returns.",
  );
});

test("ticket-analysis cron keeps the last-customer-message settle gate at the source (probe target)", () => {
  // Sanity — if the cron's own gate ever drops the `last_customer_message_at` settle, the probe's
  // added settle-window mirror would legitimately need re-thinking. Pin the cron's gate too so a
  // relaxation red-lights this test with a clear message.
  const cron = read(CRON);
  assert.match(
    cron,
    /CORA_CLOSE_SETTLE_MS/,
    "ticket-analysis-cron.ts must keep the CORA_CLOSE_SETTLE_MS settle window on last_customer_message_at — if this is dropped the probe's settle-window mirror comment is stale.",
  );
  assert.match(
    cron,
    /last_customer_message_at/,
    "ticket-analysis-cron.ts must keep the last_customer_message_at settle key — if this moves, the probe's ticket_messages/customer join is stale.",
  );
});
