/**
 * Static-analysis check: NOTHING mutates a subscription directly in Shopify.
 *
 * CEO rule (2026-07-20): a subscription is mutated through the **Appstle API** or through our
 * **internal** path — never through a raw Shopify subscription-contract/draft GraphQL mutation.
 * Both paths live behind ONE chokepoint, the commerce SDK
 * ([[../src/lib/commerce/subscription.ts]]): every `subscription*` mutation there checks
 * `isInternalSubscription(workspaceId, contractId)` and routes to the internal writer or to
 * Appstle. Callers use the SDK; they never reach a vendor API themselves.
 *
 * The rule was violated silently for months: `src/app/api/workspaces/[id]/subscriptions/[subId]/route.ts`
 * kept calling `changeNextBillingDate()` — a raw Shopify `subscriptionDraftUpdate` — for the
 * dashboard's "Change Next Order Date" action, which did the wrong thing for every internal sub
 * and diverged from the AI action path. It survived the whole `centralized-commerce-sdk` goal
 * (M4 migrated "dashboard + agent + AI" and missed this one case) and was only caught on
 * 2026-07-20 while triaging a stale PR. The module it called, `src/lib/shopify-subscriptions.ts`,
 * was deleted in the same change once that last caller was gone.
 *
 * This guard makes the rule mechanical: any NEW Shopify subscription-mutation GraphQL call
 * fails `predeploy` red instead of quietly becoming the next silent divergence. Read-only; never
 * mutates state. Mirrors the `_check-pm-sdk-compliance.ts` / `_check-pm-md-reads.ts` shape.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/** Shopify GraphQL mutations that write to a subscription contract or its draft. */
const FORBIDDEN_MUTATIONS = [
  "subscriptionContractUpdate",
  "subscriptionContractCreate",
  "subscriptionContractSetNextBillingDate",
  "subscriptionContractPause",
  "subscriptionContractActivate",
  "subscriptionDraftCommit",
  "subscriptionDraftUpdate",
  "subscriptionDraftLineAdd",
  "subscriptionDraftLineRemove",
  "subscriptionDraftLineUpdate",
  "subscriptionDraftDiscountAdd",
];

/**
 * Files allowed to NAME these mutations — prose only (a comment explaining the retired path, a
 * brain-doc generator's description string). A file here may mention the identifier; it must
 * still never issue the GraphQL call. Keep this list short and justified.
 */
const PROSE_ALLOW_LIST = new Set<string>([
  "scripts/_check-no-shopify-sub-mutations.ts", // this file
  "scripts/_gen-brain-libraries.ts", // brain-page description strings
]);

const SCAN_ROOTS = ["src", "scripts"];
const SCAN_EXTENSIONS = [".ts", ".tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

/** A line is a real call site (not prose) when the mutation name is not inside a `//` comment. */
function isProseLine(line: string, index: number): boolean {
  const commentAt = line.indexOf("//");
  return commentAt !== -1 && commentAt < index;
}

type Violation = { file: string; line: number; mutation: string; text: string };

function main(): void {
  const violations: Violation[] = [];

  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      const rel = file.replace(/^\.\//, "");
      if (PROSE_ALLOW_LIST.has(rel)) continue;
      if (rel.includes(".test.")) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const mutation of FORBIDDEN_MUTATIONS) {
          const at = line.indexOf(mutation);
          if (at === -1) continue;
          if (isProseLine(line, at)) continue;
          violations.push({ file: rel, line: i + 1, mutation, text: line.trim().slice(0, 120) });
        }
      });
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n❌ check-no-shopify-sub-mutations — ${violations.length} raw Shopify subscription mutation(s):\n`,
    );
    for (const v of violations) {
      console.error(`   ${v.file}:${v.line}  ${v.mutation}`);
      console.error(`      ${v.text}`);
    }
    console.error(
      `\n   A subscription is mutated through the Appstle API or through our internal path — never` +
        `\n   directly in Shopify. Route the write through the commerce SDK` +
        `\n   (src/lib/commerce/subscription.ts), whose subscription* functions check` +
        `\n   isInternalSubscription() and dispatch to the internal writer or to Appstle.` +
        `\n   If a genuinely Shopify-only surface is needed, raise it before adding it here.\n`,
    );
    process.exit(1);
  }

  console.log("✅ check-no-shopify-sub-mutations — no raw Shopify subscription mutations");
}

main();
