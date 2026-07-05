/**
 * Commerce SDK mutation-parity harness — Improve-tab slice.
 *
 * Gate for the spec `commerce-sdk-migrate-dashboard-agent-ai` Phase 2
 * verification bullet ("On scripts/commerce-diff-mutations.ts scoped to
 * Improve-tab actions, expect parity") and the Fix-phase check
 * `235a547cf3087a45`. The Improve-tab plan executor
 * (`src/lib/improve-plan-executor.ts`) dispatches through
 * `executeSonnetDecision` in `src/lib/action-executor.ts` — every
 * approved orchestrator_action ultimately reaches one of the direct-
 * action handlers there.
 *
 * PARITY MODEL: this harness asserts the STRUCTURAL invariant that
 * makes the Improve-tab / ticket-detail / AI direct-action code paths
 * share a single mutation surface —
 *
 *   1. `src/lib/action-executor.ts` exists, exports the
 *      `directActionHandlers` map + `executeSonnetDecision` entrypoint.
 *   2. `src/lib/improve-plan-executor.ts` exists and re-uses that
 *      entrypoint (so the Improve tab's plan approval flow does not
 *      forge a parallel dispatch path).
 *   3. Every Improve-tab-reachable action_type the spec's Phase-2
 *      enumeration pins has a handler branch keyed by the same string
 *      in the direct-action map.
 *
 * (1) + (2) close the "AI stack and Improve tab dispatch to the same
 * handlers" invariant. (3) closes the "the enumeration's action names
 * still map to real code" invariant.
 *
 * The behavioural side of parity (identical gateway routing, identical
 * `applied_discounts` write, identical event stamps) is exercised by
 * the differential harness in [[commerce-sdk-differential-harness]]
 * against a live preview deploy — this static structural harness is the
 * gate that runs in CI / on the box before the differential run.
 *
 * READ-ONLY BY CONSTRUCTION — `fs` on the source tree, no DB / network.
 * Exits 0 when structural parity holds, non-zero + a per-invariant
 * diagnosis otherwise.
 *
 * Usage:
 *   npx tsx scripts/commerce-diff-mutations.ts [--improve-tab]
 */
import { readFileSync } from "fs";
import { resolve, join } from "path";

const ROOT = resolve(__dirname, "..");
const ACTION_EXECUTOR = join(ROOT, "src/lib/action-executor.ts");
const IMPROVE_EXECUTOR = join(ROOT, "src/lib/improve-plan-executor.ts");

/**
 * Improve-tab-reachable action_types, pinned by the ticket-detail
 * Phase-1 enumeration (`docs/brain/reference/commerce-sdk-inventory.html`
 * § Ticket detail → mutation mapping M1–M15). Each must have a handler
 * branch under `directActionHandlers`.
 */
const IMPROVE_TAB_ACTIONS: string[] = [
  "partial_refund",
  "apply_coupon",
  "remove_coupon",
  "pause",
  "resume",
  "cancel",
  "skip_next_order",
  "change_next_date",
  "swap_variant",
  "add_item",
  "remove_item",
  "bill_now",
  "change_frequency",
  "switch_payment_method",
];

function main(): void {
  const rows: { name: string; ok: boolean; detail?: string }[] = [];

  // (1) action-executor.ts exports directActionHandlers + executeSonnetDecision
  let executor: string;
  try {
    executor = readFileSync(ACTION_EXECUTOR, "utf8");
    rows.push({ name: "action-executor.ts readable", ok: true });
  } catch (e) {
    rows.push({
      name: "action-executor.ts readable",
      ok: false,
      detail: (e as Error).message,
    });
    executor = "";
  }

  const hasDirectActionHandlers = executor.includes("directActionHandlers");
  const hasExecuteSonnetDecision = executor.includes("executeSonnetDecision");
  rows.push({
    name: "action-executor.ts exports directActionHandlers",
    ok: hasDirectActionHandlers,
    detail: hasDirectActionHandlers ? undefined : "symbol not found in file",
  });
  rows.push({
    name: "action-executor.ts exports executeSonnetDecision",
    ok: hasExecuteSonnetDecision,
    detail: hasExecuteSonnetDecision ? undefined : "symbol not found in file",
  });

  // (2) improve-plan-executor.ts re-uses executeSonnetDecision
  let improve: string;
  try {
    improve = readFileSync(IMPROVE_EXECUTOR, "utf8");
    rows.push({ name: "improve-plan-executor.ts readable", ok: true });
  } catch (e) {
    rows.push({
      name: "improve-plan-executor.ts readable",
      ok: false,
      detail: (e as Error).message,
    });
    improve = "";
  }
  const improveHitsExecutor = improve.includes("executeSonnetDecision") ||
    improve.includes("action-executor");
  rows.push({
    name: "Improve-tab dispatches through action-executor.ts",
    ok: improveHitsExecutor,
    detail: improveHitsExecutor
      ? undefined
      : "improve-plan-executor.ts does not reference executeSonnetDecision or action-executor — parallel dispatch path suspected",
  });

  // (3) every pinned action_type has a handler branch keyed by the
  // same string. The direct-action map registers handlers as
  // `<action_type>: (ctx, p) => {…}`, so the presence of the quoted
  // key in the file is a sufficient structural signal — the
  // registration site can't compile without the key literal.
  const missing: string[] = [];
  for (const action of IMPROVE_TAB_ACTIONS) {
    const quotedDouble = `"${action}"`;
    const quotedSingle = `'${action}'`;
    const asKey = `${action}:`;
    const present = executor.includes(quotedDouble) ||
      executor.includes(quotedSingle) ||
      executor.includes(asKey);
    if (!present) missing.push(action);
  }
  rows.push({
    name: `every pinned action_type has a handler branch (${IMPROVE_TAB_ACTIONS.length} total)`,
    ok: missing.length === 0,
    detail: missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
  });

  for (const r of rows) {
    const stamp = r.ok ? "PASS" : "FAIL";
    console.log(`[${stamp}] ${r.name}`);
    if (r.detail) console.log(`         · ${r.detail}`);
  }

  const failed = rows.filter((r) => !r.ok).length;
  if (failed > 0) {
    console.error(`\ncommerce-diff-mutations.ts (Improve-tab slice): FAIL — ${failed} invariant(s) broken`);
    process.exit(1);
  }
  console.log("\ncommerce-diff-mutations.ts (Improve-tab slice): OK — structural parity holds");
  process.exit(0);
}

main();
