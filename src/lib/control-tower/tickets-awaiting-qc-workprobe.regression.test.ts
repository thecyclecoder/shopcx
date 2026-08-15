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
import { ticketAnalyzerEligibilityReadyAt } from "./monitor";

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

// ── ticket-analyzer-workprobe-eligibility-grace ──────────────────────────────────────────────
// Pin the fresh-close eligibility helper: a ticket the cron will legitimately process on the
// NEXT feeder tick (customer message settled hours ago, close/handled stamps only minutes ago)
// must NOT be counted as awaited work yet. The prior probe used customer-message settle as the
// only clock, so a freshly-closed ticket looked overdue in the between-tick gap it landed in —
// a false idle_while_work on loop:ai:ticket-analyzer.

test("ticketAnalyzerEligibilityReadyAt: fresh close/handled on an old customer message defers eligibility to the fresh anchor", () => {
  // Ticket the customer last messaged 3h ago (long past settle) but that only closed and got
  // Sol-handled 5 minutes ago. Ready-at MUST anchor on the fresh close/handled stamps, so the
  // effective wait time (now - readyAt) is ~5 min — well under a 40-min feeder-grace window —
  // and the probe caller does not count it as awaited work.
  const now = Date.now();
  const readyAt = ticketAnalyzerEligibilityReadyAt({
    closedAtMs: now - 5 * 60_000,
    aiHandledAtMs: null,
    solHandledAtMs: now - 5 * 60_000,
    latestCustomerMessageAtMs: now - 3 * 60 * 60_000,
    coraSettleMs: 30 * 60_000,
  });
  assert.ok(readyAt != null, "readyAt should be non-null — ticket has closed_at, handled, and customer msg");
  const waitedMs = now - readyAt!;
  assert.ok(
    waitedMs < 40 * 60_000,
    `freshly-closed ticket must not have waited a full feeder grace yet (got ${waitedMs}ms) — the probe would false-alert on it`,
  );
  assert.ok(
    Math.abs(waitedMs - 5 * 60_000) < 1_000,
    `readyAt should anchor on the fresh close/handled stamp (~5 min), got ${waitedMs}ms — the customer-message clock alone would make it look 3h stale`,
  );
});

test("ticketAnalyzerEligibilityReadyAt: fully-settled and past-a-cycle ticket IS eligible", () => {
  // Contrast case — everything happened hours ago, cron had multiple ticks to service it and
  // did not, so the probe SHOULD count it as awaited work.
  const now = Date.now();
  const readyAt = ticketAnalyzerEligibilityReadyAt({
    closedAtMs: now - 3 * 60 * 60_000,
    aiHandledAtMs: now - 3 * 60 * 60_000,
    solHandledAtMs: now - 3 * 60 * 60_000,
    latestCustomerMessageAtMs: now - 3 * 60 * 60_000,
    coraSettleMs: 30 * 60_000,
  });
  assert.ok(readyAt != null);
  assert.ok((now - readyAt!) >= 40 * 60_000, "fully-settled past-a-cycle ticket must be counted");
});

test("ticketAnalyzerEligibilityReadyAt: missing customer message / handled / closed_at → null (cron would skip)", () => {
  const now = Date.now();
  const base = {
    closedAtMs: now - 3 * 60 * 60_000,
    aiHandledAtMs: now - 3 * 60 * 60_000,
    solHandledAtMs: null as number | null,
    latestCustomerMessageAtMs: now - 3 * 60 * 60_000 as number | null,
    coraSettleMs: 30 * 60_000,
  };
  assert.equal(ticketAnalyzerEligibilityReadyAt({ ...base, latestCustomerMessageAtMs: null }), null);
  assert.equal(ticketAnalyzerEligibilityReadyAt({ ...base, closedAtMs: null }), null);
  assert.equal(ticketAnalyzerEligibilityReadyAt({ ...base, aiHandledAtMs: null, solHandledAtMs: null }), null);
});

test("ticketAnalyzerEligibilityReadyAt: settle window still gates when close + handled are older than settle", () => {
  // Close and handled happened days ago, but the customer sent a fresh message 2 min ago.
  // The cron's `passesCoraSelectionGate` would refuse to grade the ticket until CORA_CLOSE_SETTLE_MS
  // has passed since that customer message — so the probe must not count it either.
  const now = Date.now();
  const readyAt = ticketAnalyzerEligibilityReadyAt({
    closedAtMs: now - 2 * 24 * 60 * 60_000,
    aiHandledAtMs: now - 2 * 24 * 60 * 60_000,
    solHandledAtMs: null,
    latestCustomerMessageAtMs: now - 2 * 60_000,
    coraSettleMs: 30 * 60_000,
  });
  assert.ok(readyAt != null);
  // ready-at should be ~28 min in the FUTURE (customer msg + 30 min settle), so waited < 0.
  const waitedMs = now - readyAt!;
  assert.ok(waitedMs < 0, `settle window should push readyAt into the future while customer is still active (got ${waitedMs}ms)`);
});

// ── ticket-analyzer-workprobe-eligibility-grace: probe-block wiring ─────────────────────────
// Ensure the probe actually consumes the helper AND selects the fresh anchors it needs. A
// refactor that reverts to the customer-message-only cutoff would silently re-open the between-
// tick false alert.

test("tickets-awaiting-qc probe calls ticketAnalyzerEligibilityReadyAt and requires the readyAt to have aged past a feeder cycle", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  assert.match(
    block,
    /ticketAnalyzerEligibilityReadyAt\s*\(/,
    "`tickets-awaiting-qc` probe must call the ticketAnalyzerEligibilityReadyAt helper — customer-message settle alone lets a freshly-closed ticket false-alert in the between-tick gap.",
  );
  assert.match(
    block,
    /(?:nowMs|Date\.now\(\))\s*-\s*readyAt\s*<\s*TICKET_ANALYSIS_FEEDER_GRACE_MS/,
    "`tickets-awaiting-qc` probe must skip a candidate whose readyAt has not yet aged past TICKET_ANALYSIS_FEEDER_GRACE_MS — otherwise a freshly-closed ticket is counted before the next cron tick could legally service it.",
  );
});

test("tickets-awaiting-qc probe selects closed_at, ai_handled_at, and sol_handled_at (fresh-anchor inputs)", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  assert.match(
    block,
    /\.select\(\s*"[^"]*closed_at[^"]*ai_handled_at[^"]*sol_handled_at[^"]*"\s*\)|\.select\(\s*"[^"]*sol_handled_at[^"]*ai_handled_at[^"]*closed_at[^"]*"\s*\)|\.select\(\s*"[^"]*(?:closed_at|ai_handled_at|sol_handled_at)[^"]*(?:closed_at|ai_handled_at|sol_handled_at)[^"]*(?:closed_at|ai_handled_at|sol_handled_at)[^"]*"\s*\)/,
    "`tickets-awaiting-qc` candidate select must include closed_at, ai_handled_at, and sol_handled_at — the helper needs the fresh anchors to defer eligibility past a between-tick close.",
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

// ── ticket-analyzer-workprobe-exclude-june-decided-cycles ───────────────────────────────────
// The cron's `passesCoraSelectionGate` (ticket-analysis-cron.ts § 81) skips a candidate when a
// `cs_director_call` `director_activity` row for the ticket landed at-or-after the current
// handling anchor (later(ai_handled_at, sol_handled_at)). The work probe must mirror that lookup
// or a healthy analyzer whose only in-window ticket was already ruled on by June flips red
// (false idle_while_work on loop:ai:ticket-analyzer). These pins guard the four moving parts:
// the director_activity table read, the cs_director_call action_kind filter, the
// metadata.ticket_id mapping, and the same-cycle comparison against the handling anchor.

test("tickets-awaiting-qc probe queries director_activity (June-decided cycle mirror)", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  assert.match(
    block,
    /\.from\(\s*"director_activity"\s*\)/,
    "`tickets-awaiting-qc` probe must query the director_activity table — the cron's `passesCoraSelectionGate` skips tickets June already decided this cycle; keying the probe on the same lookup keeps it from flagging a June-ruled ticket as awaited work (a monitor-false-positive on a healthy analyzer).",
  );
});

test("tickets-awaiting-qc probe filters director_activity on action_kind='cs_director_call'", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  assert.match(
    block,
    /\.eq\(\s*"action_kind"\s*,\s*"cs_director_call"\s*\)/,
    "`tickets-awaiting-qc` probe must filter director_activity on action_kind='cs_director_call' — the June-decision audit uses that action_kind (see cs-director.ts + ticket-analysis-cron.ts § 221), so any other kind is unrelated activity and must not gate the probe.",
  );
});

test("tickets-awaiting-qc probe scopes director_activity to the candidate workspaces", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  assert.match(
    block,
    /\.in\(\s*"workspace_id"\s*,/,
    "`tickets-awaiting-qc` probe must scope the director_activity lookup with .in('workspace_id', …) over the candidate workspaces — mirrors the cron's per-workspace scoping (ticket-analysis-cron.ts § 218-223) and keeps the query bounded.",
  );
  assert.match(
    block,
    /\.select\(\s*"[^"]*workspace_id[^"]*"\s*\)/,
    "`tickets-awaiting-qc` candidate select must include workspace_id — the director_activity scope needs the unique workspaces to filter on.",
  );
});

test("tickets-awaiting-qc probe keys the June-decided map on metadata.ticket_id", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  assert.match(
    block,
    /metadata\.ticket_id/,
    "`tickets-awaiting-qc` probe must read `metadata.ticket_id` off each director_activity row — that's where the runner (scripts/builder-worker.ts) records the ticket this cs_director_call verdict was about. Keying on anything else would silently drop the entire lookup.",
  );
  assert.match(
    block,
    /latestJuneDecidedAtByTicket/,
    "`tickets-awaiting-qc` probe must build a `latestJuneDecidedAtByTicket` map (the same name the spec's Phase 1 vocabulary uses) so the compare below reads the freshest June decision per ticket, not a stale earlier one.",
  );
});

test("tickets-awaiting-qc probe skips a candidate when June's decision is at-or-after the handling anchor", () => {
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  // The compare must be against `handledMs` (the later of ai_handled_at / sol_handled_at) — a
  // June decision from a PRIOR cycle (decidedMs < handledMs) is inert. A `juneMs >= handledMs`
  // shape is what tells the probe "current cycle already decided → cron skips → we skip too".
  assert.match(
    block,
    /juneMs\s*>=\s*handledMs/,
    "`tickets-awaiting-qc` probe must compare `juneMs >= handledMs` (later of ai_handled_at + sol_handled_at) and `continue` on match — mirrors `passesCoraSelectionGate`'s `decidedMs >= handledMs` skip (ticket-analysis-cron.ts § 111-116). Any weaker predicate (e.g. `juneMs != null` alone, or comparing against `closed_at`) either over-skips genuine work OR keeps flagging a June-ruled ticket.",
  );
  assert.match(
    block,
    /Math\.max\(\s*aiMs\s*,\s*solMs\s*\)|Math\.max\(\s*solMs\s*,\s*aiMs\s*\)/,
    "`tickets-awaiting-qc` probe must derive the handling anchor as `Math.max(aiMs, solMs)` when both stamps are present — matches the cron's `laterTimestamp(ai_handled_at, sol_handled_at)`. Picking only one stamp would misclassify a ticket whose OTHER handler stamped later.",
  );
});

test("ticket-analysis cron continues to gate on the June-decided lookup at the source (probe target)", () => {
  // Sanity — if the cron's own gate ever drops the `cs_director_call` skip or the metadata-based
  // per-ticket map, the probe's mirror would legitimately need re-thinking. Pin the cron's shape
  // here so a relaxation red-lights this test with a clear message.
  const cron = read(CRON);
  assert.match(
    cron,
    /\.eq\(\s*"action_kind"\s*,\s*"cs_director_call"\s*\)/,
    "ticket-analysis-cron find-tickets must keep the cs_director_call director_activity lookup — if this is dropped the probe's June-decided mirror comment is stale.",
  );
  assert.match(
    cron,
    /metadata\.ticket_id/,
    "ticket-analysis-cron find-tickets must keep the metadata.ticket_id key on the June-decided map — if this moves, the probe's key is stale.",
  );
});

// ── ticket-analyzer-workprobe-june-decision-lookback-align ──────────────────────────────────
// The cron's `director_activity` scan uses a 7-day cutoff (ticket-analysis-cron.ts:143), not the
// loop's 2h liveness window. The probe previously scoped the same lookup with `sinceIso` (the 2h
// loop window), so a same-cycle June decision that landed 3h ago was silently dropped from the
// probe's map — the cron correctly skipped the ticket while the probe counted it as awaited work,
// firing a false idle_while_work on a healthy loop:ai:ticket-analyzer. These pins guard the
// cron-aligned lookback: the named constant, its value, that the probe uses it (NOT `sinceIso`)
// for the director_activity `.gte("created_at", …)`, and the boundary the fix is meant to close.

test("monitor.ts defines TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS = 7 days (cron-aligned)", () => {
  // Named-constant + value pin. The cron's candidate horizon is `7 * 24 * 60 * 60 * 1000` at
  // ticket-analysis-cron.ts:143; the probe's June-decision lookback MUST match or the probe
  // silently reads a smaller universe than the cron and false-flags a June-decided ticket.
  const monitor = read(MONITOR);
  const monitorMatch = monitor.match(/TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS\s*=\s*([^;]+);/);
  assert.ok(
    monitorMatch,
    "monitor.ts must define TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS = <expr>; — the dedicated cron-aligned June-decision lookback for the tickets-awaiting-qc probe. Without this the director_activity lookup silently reuses the loop's liveness window and drops a same-cycle June decision older than 2h.",
  );
  const monitorMs = Function(`"use strict"; return (${monitorMatch[1]});`)() as number;
  assert.equal(
    monitorMs,
    7 * 24 * 60 * 60_000,
    "TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS must equal 7 days (7 * 24 * 60 * 60_000) — mirrors the cron's `cutoff = now - 7 * 24 * 60 * 60 * 1000` at ticket-analysis-cron.ts:143. A shorter value re-opens the false-alert window this spec closes.",
  );
});

test("monitor's TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS matches the ticket-analysis cron's candidate horizon", () => {
  // Drift pin: the cron computes its 7-day cutoff inline as an arithmetic literal. Extract that
  // arithmetic literal from the cron source and assert the monitor's named constant evaluates to
  // the same number. If the cron ever moves its horizon the two must move together or the probe
  // diverges silently.
  const monitor = read(MONITOR);
  const cron = read(CRON);
  const monitorMatch = monitor.match(/TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS\s*=\s*([^;]+);/);
  assert.ok(monitorMatch, "monitor.ts must define TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS = <expr>;");
  const cronMatch = cron.match(
    /new\s+Date\(\s*Date\.now\(\)\s*-\s*(\d[\d\s*_]*(?:\*\s*\d[\d_]*)+)\s*\)\.toISOString\(\)/,
  );
  assert.ok(
    cronMatch,
    "ticket-analysis-cron.ts must keep its inline `new Date(Date.now() - <arith>).toISOString()` cutoff expression for the candidate horizon — the drift pin extracts <arith> to compare against the monitor's named constant. If this expression is refactored, hoist it into a named export and update this pin.",
  );
  const monitorMs = Function(`"use strict"; return (${monitorMatch[1]});`)() as number;
  const cronMs = Function(`"use strict"; return (${cronMatch[1]});`)() as number;
  assert.equal(
    monitorMs,
    cronMs,
    "TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS in monitor.ts must equal the cron's `now - <arith>` cutoff at ticket-analysis-cron.ts:143 — the probe and the cron must scan the same director_activity universe or a same-cycle June decision older than the loop's 2h window is silently dropped.",
  );
});

test("tickets-awaiting-qc probe uses the cron-aligned June-decision cutoff (NOT the 2h loop window) for director_activity", () => {
  // The tightened assertion this spec ships. The block-level match ensures the probe's
  // director_activity `.gte("created_at", …)` argument is a cutoff derived from the dedicated
  // 7-day constant, NOT the shared `sinceIso` variable (which mirrors loop.livenessWindowMs = 2h
  // for loop:ai:ticket-analyzer). A regression to `sinceIso` here re-opens the boundary: a same-
  // cycle June decision landed 3h ago is invisible to the probe but visible to the cron, and the
  // probe false-counts the ticket as awaited work.
  const block = ticketsAwaitingQcBlock(read(MONITOR));
  // Find the director_activity chain and pull the .gte("created_at", <var>) argument off it.
  const chainMatch = block.match(
    /\.from\(\s*"director_activity"\s*\)[\s\S]*?\.gte\(\s*"created_at"\s*,\s*([A-Za-z_$][\w$]*)\s*\)/,
  );
  assert.ok(
    chainMatch,
    "`tickets-awaiting-qc` probe must call `.gte(\"created_at\", <var>)` on the director_activity chain — the June-decision cutoff argument is what this spec's alignment fix keys on.",
  );
  const cutoffVar = chainMatch[1];
  assert.notEqual(
    cutoffVar,
    "sinceIso",
    "`tickets-awaiting-qc` probe must NOT scope director_activity with `sinceIso` — that's the loop's 2h liveness window and it silently drops a same-cycle June decision older than 2h, re-opening the exact false-alert window this spec closes. Use a dedicated cron-aligned cutoff (e.g. `juneDecisionCutoffIso`) derived from TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS.",
  );
  // Assert the cutoff variable is derived from the dedicated lookback constant — otherwise a
  // stealth reuse of any other short window (e.g. a locally-named `windowMs`) would sneak past
  // the `!== "sinceIso"` guard.
  const derivationRegex = new RegExp(
    `${cutoffVar}\\s*=\\s*[^;]*TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS`,
  );
  assert.match(
    block,
    derivationRegex,
    `\`${cutoffVar}\` must be derived from TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS in the probe block — otherwise the cutoff is a stealth reuse of another short window and the probe silently diverges from the cron's 7-day candidate horizon.`,
  );
});

test("boundary: a same-cycle June decision older than the loop's 2h liveness window still lies inside the probe's cron-aligned lookback", () => {
  // The failing boundary this spec repairs, encoded as a pure predicate:
  //   - candidate updated inside the 2-hour loop liveness window (nowMs - updatedMs < 2h);
  //   - Sol handled the ticket 1h ago (handledMs = nowMs - 1h);
  //   - June decided 30 min ago (juneMs = nowMs - 30min) — later than handledMs (same cycle);
  //   - the June decision is older than the loop's 2h window (nowMs - juneMs > 2h) is FALSE
  //     here (30 min < 2h), but the ORIGINAL false-alert case is `juneMs 3h old` — see below.
  // The critical case: `juneMs = nowMs - 3h` — older than 2h (loop window) but well inside 7d
  // (cron horizon). The 2h window would drop it, the 7d window keeps it, so the probe's map
  // still contains this June decision → the compare `juneMs >= handledMs` fires → skip.
  const monitor = read(MONITOR);
  const monitorMatch = monitor.match(/TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS\s*=\s*([^;]+);/);
  assert.ok(monitorMatch, "monitor.ts must define TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS = <expr>;");
  const lookbackMs = Function(`"use strict"; return (${monitorMatch[1]});`)() as number;
  const nowMs = 1_723_690_000_000;
  const twoHours = 2 * 60 * 60_000;
  const handledMs = nowMs - 1 * 60 * 60_000; // Sol handled 1h ago (inside the 2h loop window)
  const juneMs = nowMs - 3 * 60 * 60_000; // June decided 3h ago (older than the loop window)
  // The failing state we are pinning: june is older than the loop's 2h window …
  assert.ok(nowMs - juneMs > twoHours, "juneMs must be older than 2h to exercise the failing boundary");
  // … AND the June decision landed BEFORE Sol's handling of this cycle in wall-clock terms — but
  // the FAILING case has June AFTER handled (same cycle). Adjust: put juneMs after handledMs.
  const juneMsSameCycle = handledMs + 30 * 60_000; // June ruled 30 min after Sol handled
  assert.ok(juneMsSameCycle >= handledMs, "same-cycle June decision must be at-or-after handling anchor");
  // For the 2h window (`sinceIso` path), a decision that lands at handledMs+30min still lies
  // 30min ago in this construction — so use the truly-adversarial case: June 30min after handled,
  // then a longer wait bumps everything back. Anchor the ticket further back and re-derive.
  const handledOld = nowMs - 4 * 60 * 60_000;
  const juneOld = handledOld + 30 * 60_000; // June ruled 30 min after handled, now 3.5h ago
  assert.ok(nowMs - juneOld > twoHours, "adversarial juneOld is older than the 2h loop window");
  assert.ok(juneOld >= handledOld, "adversarial juneOld is same-cycle (at-or-after handledOld)");
  // The cron-aligned lookback MUST include this decision so the probe's map contains it and the
  // `juneMs >= handledMs` skip fires. Equivalent: cutoff ≤ juneOld ⇔ (nowMs - lookbackMs) ≤ juneOld.
  assert.ok(
    nowMs - lookbackMs <= juneOld,
    `TICKET_ANALYSIS_JUNE_DECISION_LOOKBACK_MS (${lookbackMs}ms) must be large enough that a same-cycle June decision landed 3.5h ago (older than the loop's 2h window) is still inside the cutoff. If this fails the probe would silently drop that decision and re-open the false idle_while_work on loop:ai:ticket-analyzer.`,
  );
  // Contrast: the OLD 2h-window path (`sinceIso`) would have failed here, proving the boundary.
  const oldLoopWindowMs = 2 * 60 * 60_000;
  assert.ok(
    !(nowMs - oldLoopWindowMs <= juneOld),
    "sanity: the old 2h loop window WOULD have dropped this June decision — that's the false-positive boundary this spec closes.",
  );
});
