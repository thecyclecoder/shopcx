/**
 * analyzer-research-tools — bounded READ-ONLY research tools for the box's ticket-analyze
 * agent (Cora). Phases 1 + 3 of docs/brain/specs/cora-gets-readonly-research-power-to-verify-claims-before-grading.md.
 *
 * Cora grades the AI's conversation window against the QC rubric. Previously she could only
 * grade what the transcript showed — a claim she couldn't confirm from the transcript became
 * a guess. This CLI gives her a HANDFUL of targeted read-only lookups so she can verify a
 * claim (a variant/flavor, an actual per-unit charged amount, a subscription state, a
 * customer profile fact) BEFORE grading it. Brain/policy read still happens directly via
 * Claude Code's Read/Grep against docs/brain/.
 *
 * Bound (Phase 3):
 *   • READ-ONLY at the allowlist level — only reads from the shared executor land here.
 *   • NO MUTATION at the executor level — sonnet-orchestrator-v2's executeToolCall never writes;
 *     the analyzer's only write is its verdict, applied by the deterministic worker's
 *     applyAnalyzerVerdict in src/lib/ticket-analyzer.ts.
 *   • TARGETED lookups per grade — a hard per-ticket counter (env ANALYZER_RESEARCH_CAP,
 *     default 8) refuses further calls once the cap is hit within a single grade. The counter
 *     is a ticket-scoped `/tmp/analyzer-research-<ticketId>.count` file that resets after
 *     30 min of staleness (well beyond any grade's runtime). This forces the "targeted, not
 *     open-ended" discipline the spec names.
 *
 * NEVER mutates. The analyzer's ONLY write is its verdict, and that flows back through
 * applyAnalyzerVerdict on the deterministic worker — not from this CLI.
 *
 * Usage (from the ticket-analyze skill):
 *   npx tsx scripts/analyzer-research-tools.ts <tool> <ticket_id> [json_input]
 *
 * Tools: get_customer_account · get_product_knowledge · get_product_nutrition · get_returns ·
 *        get_ticket_analysis
 *
 * Prints the tool's text result to stdout. See docs/brain/specs/cora-gets-readonly-research-power-to-verify-claims-before-grading.md.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

// The bounded allowlist. Deliberately narrower than the improve-tools set — Cora's job is
// to VERIFY a specific transcript claim, not to open-endedly investigate the whole account.
// Covers the exact surfaces the spec names: product (variants/flavors/pricing) · order +
// line-item (actual charged amounts, via get_customer_account's orders block) · subscription
// + customer (get_customer_account) · latest analysis (get_ticket_analysis). Brain/policy
// read happens via Claude Code's native Read/Grep against docs/brain/, not here.
const READ_TOOLS = new Set([
  "get_customer_account",
  "get_product_knowledge",
  "get_product_nutrition",
  "get_returns",
  "get_ticket_analysis",
]);

// Phase 3 — per-grade cap. Each ticket-analyze session is one grade on one ticket, so a
// ticket-scoped counter file bounds how many read-only lookups Cora spends on any single
// grade. Default 8 (a "handful") — override via ANALYZER_RESEARCH_CAP. The file lives at
// /tmp/analyzer-research-<ticketId>.count; a file older than STALE_MS is treated as a fresh
// grade and reset (30 min is well past any single ticket-analyze session's runtime, so a
// slow grade can't leak into the next one on the same ticket). The refusal path is the
// bound Cora is meant to hit when she's exhausted her targeted lookups — she should fall
// through to the low-confidence unverified handling from there, per the spec's Phase 2
// research-first / unverified-fallback ordering.
const RESEARCH_CAP = Math.max(1, Number(process.env.ANALYZER_RESEARCH_CAP ?? "8"));
const STALE_MS = 30 * 60_000;

function readCounter(ticketId: string): { path: string; count: number } {
  const path = `/tmp/analyzer-research-${ticketId}.count`;
  if (!existsSync(path)) return { path, count: 0 };
  try {
    const stat = statSync(path);
    if (Date.now() - stat.mtimeMs >= STALE_MS) return { path, count: 0 };
    const parsed = Number(readFileSync(path, "utf8").trim());
    return { path, count: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 };
  } catch {
    return { path, count: 0 };
  }
}

function bumpCounter(path: string, next: number): void {
  try {
    writeFileSync(path, String(next));
  } catch {
    // Counter is best-effort — a full disk shouldn't block a grade. The refusal above still
    // fires when the counter is readable (the common case); a missing counter would let a
    // few extra lookups through, which is the safer failure mode than false-refusing a grade.
  }
}

async function main() {
  const [, , tool, ticketId, inputJson] = process.argv;
  if (!tool || !ticketId) {
    console.error("usage: analyzer-research-tools.ts <tool> <ticket_id> [json_input]");
    process.exit(2);
  }
  if (!READ_TOOLS.has(tool)) {
    console.error(`refused: '${tool}' is not an analyzer read-only research tool. Allowed: ${[...READ_TOOLS].join(", ")}`);
    process.exit(2);
  }
  let input: Record<string, unknown> = {};
  if (inputJson) {
    try {
      input = JSON.parse(inputJson);
    } catch {
      console.error("input must be valid JSON");
      process.exit(2);
    }
  }

  // Enforce the per-grade cap BEFORE resolving the ticket / spinning up an admin client —
  // Cora's refusal path should be as cheap as possible so she can pivot to the low-confidence
  // unverified handling without paying the DB roundtrip.
  const counter = readCounter(ticketId);
  if (counter.count >= RESEARCH_CAP) {
    console.error(
      `refused: analyzer research cap reached (${counter.count}/${RESEARCH_CAP} lookups this grade). ` +
        `This CLI is deliberately bounded — grade the truth from what you've already learned, or fall ` +
        `through to the low-confidence unverified handling (do NOT emit 'inaccuracy' on a claim you ` +
        `couldn't verify; prefer 'kb_gap' or omit).`,
    );
    process.exit(2);
  }

  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, workspace_id, customer_id")
    .eq("id", ticketId)
    .single();
  if (!ticket) {
    console.error(`ticket ${ticketId} not found`);
    process.exit(1);
  }

  // Bump the counter BEFORE the lookup so a hung/interrupted call still counts — otherwise a
  // partial call could reset back to 0 on the next invocation via the stale-file window.
  bumpCounter(counter.path, counter.count + 1);

  // Delegate to the shared read-only tool executor — same code path improve/handle/orchestrator
  // use. Preserves the linked-account expansion (resolveLinkedCustomerIds) so a claim on a
  // sibling profile is still visible, and preserves the per-line pricing block that lets Cora
  // compare the AI's per-unit claim to the ACTUAL charged amounts.
  const { default: executeToolCallImprove } = await import("../src/lib/improve-tools");
  const result = await executeToolCallImprove(tool, input, ticket.workspace_id, { id: ticket.id });
  process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));
  // Emit the running count to stderr as a soft signal — Cora can see how close she is to the
  // cap without parsing counter files. stderr, not stdout, so the tool result stays clean.
  process.stderr.write(`[analyzer-research] ${counter.count + 1}/${RESEARCH_CAP} lookups this grade\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
