/**
 * Static-analysis check: NOTHING mutates an Appstle subscription with a raw
 * `subscription-admin.appstle.com` fetch outside the vendor wrapper modules
 * + the commerce SDK.
 *
 * A subscription is mutated through the vendor (Appstle) OR through our
 * internal path — never both, never the wrong one — and every write flows
 * through the ONE chokepoint that knows how to tell those two kinds apart:
 * the commerce SDK ([[../src/lib/commerce/subscription.ts]]). Each mutation
 * there checks `isInternalSubscription(workspaceId, contractId)` and routes
 * to the internal writer or to the vendor wrapper. Callers use the SDK;
 * they never build a `subscription-admin.appstle.com` fetch themselves.
 *
 * The rule was violated silently twice: `src/lib/inngest/dunning.ts`
 * `resetBillingDateAfterDunning` and `src/app/api/journey/[token]/complete/route.ts`'s
 * shipping-address completion block both hand-rolled the vendor PUT with no
 * internal-vs-Appstle branch, so an internal sub's dunning recovery or address
 * change silently sent an internal contract id the vendor never issued. Both
 * were caught in July 2026 while triaging the folded `centralized-commerce-sdk`
 * goal (see the internal-sub-write-path-gaps spec).
 *
 * This guard makes the rule mechanical: any NEW mutating vendor fetch outside
 * the allow-list below fails `predeploy` red instead of quietly becoming the
 * next silent divergence. Read-only; never mutates state. Mirrors the shape
 * of `scripts/_check-no-shopify-sub-mutations.ts`.
 *
 * Detection: a `subscription-admin.appstle.com` URL string paired with a
 * mutating method (`PUT` / `POST` / `DELETE`) in the SAME fetch call —
 * detected by scanning within a small window of the URL line for
 * `method: "PUT"|"POST"|"DELETE"`. Read-only (`GET`) calls are out of scope
 * (reading a contract the vendor doesn't know is harmless; the defect class
 * is lost writes).
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Files allowed to issue a mutating `subscription-admin.appstle.com` fetch.
 * One-line reason per entry.
 *
 *  - Exact-path entries match the file's repo-relative path verbatim.
 *  - Prefix entries end in `/` and match any file under that directory.
 *
 * Keep this list short and justified — do NOT add a new file here as a
 * workaround for a caller that should be going through the commerce SDK.
 * The whole point of the guard is that a hand-rolled vendor call fails
 * CI at author time.
 */
const ALLOW_LIST: ReadonlyArray<{ path: string; reason: string }> = [
  // Vendor wrapper modules — the ONLY files that speak Appstle REST directly.
  { path: "src/lib/appstle.ts", reason: "vendor wrapper — the internal-aware SDK dispatches here for Appstle subs" },
  { path: "src/lib/appstle-discount.ts", reason: "vendor wrapper — Appstle discount endpoints" },
  { path: "src/lib/appstle-pricing.ts", reason: "vendor wrapper — Appstle pricing / healOnTouch" },
  { path: "src/lib/subscription-items.ts", reason: "line-item mutations behind the SDK's item ops" },
  // The commerce SDK is the chokepoint every caller MUST use.
  { path: "src/lib/commerce/", reason: "commerce SDK — the one chokepoint that branches internal-vs-Appstle" },
  // Migration lane: pre-migration contracts still live on the vendor.
  { path: "src/lib/migrate-to-internal.ts", reason: "internal migration must genuinely reach the vendor for pre-migration contracts" },
  { path: "src/lib/migration-audit.ts", reason: "migration audit needs to talk to the vendor about pre-migration contracts" },
  // Vendor webhook route: Appstle → us. Any outbound sync from this route is by
  // definition a vendor-side conversation.
  { path: "src/app/api/webhooks/appstle/", reason: "vendor webhook route — talks back to Appstle about vendor state" },
  // ─────────────────────────────────────────────────────────────────────
  // Legacy portal handlers — pre-SDK code paths that still hand-roll the
  // vendor call. They MUST NOT gain new hand-rolled endpoints; migrating
  // them to the commerce SDK (`subscription*` surface) is tracked
  // separately. Listed here so the guard doesn't red-flag the pre-existing
  // baseline while still catching NEW files that bypass the SDK.
  // ─────────────────────────────────────────────────────────────────────
  { path: "src/lib/portal/handlers/address.ts", reason: "legacy pre-SDK portal — TODO migrate to subscriptionUpdateShippingAddress" },
  { path: "src/lib/portal/handlers/coupon.ts", reason: "legacy pre-SDK portal — TODO migrate to subscriptionRemoveCoupon" },
  { path: "src/lib/portal/handlers/reactivate.ts", reason: "legacy pre-SDK portal — TODO migrate to subscriptionUpdateNextBillingDate" },
  { path: "src/lib/portal/handlers/replace-variants.ts", reason: "legacy pre-SDK portal — TODO migrate to subscriptionSwapVariant" },
  // Reactive dunning cron — removed in Phase 3 of the internal-sub-write-path-gaps
  // spec once its internal-guard lands. Kept here so Phase 4's guard doesn't
  // block on the same file the sibling phase is about to fix.
  { path: "src/lib/inngest/dunning.ts", reason: "removed in Phase 3 of internal-sub-write-path-gaps (resetBillingDateAfterDunning gains an isInternalSubscription early-return)" },
];

const MUTATING_METHOD_RE = /method\s*:\s*["'`](PUT|POST|DELETE)["'`]/;
const APPSTLE_URL_RE = /subscription-admin\.appstle\.com/;
/** Window (in lines) around the URL to look for a mutating method — enough
 *  to catch a `fetch(url, { method: "PUT", … })` split across a dozen lines. */
const METHOD_LOOKAHEAD_LINES = 12;
/** Scope: only src/ per the spec. scripts/*.ts are throwaway operator tools
 *  and would drown the signal. */
const SCAN_ROOT = "src";
const SCAN_EXTENSIONS = [".ts", ".tsx"];

function isAllowed(rel: string): { allowed: boolean; reason?: string } {
  for (const entry of ALLOW_LIST) {
    if (entry.path.endsWith("/")) {
      if (rel.startsWith(entry.path)) return { allowed: true, reason: entry.reason };
    } else if (rel === entry.path) {
      return { allowed: true, reason: entry.reason };
    }
  }
  return { allowed: false };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * A URL match is prose when it appears inside a `//` line comment. Skips
 * `//` that is part of a URL literal (`http://`, `https://`) or a template
 * so a `subscription-admin.appstle.com` inside a real string doesn't get
 * treated as a comment.
 */
function isProseLine(line: string, index: number): boolean {
  const before = line.slice(0, index);
  const noUrl = before.replace(/https?:\/\//g, "");
  const commentAt = noUrl.indexOf("//");
  return commentAt !== -1;
}

type Violation = { file: string; line: number; method: string; text: string };

export function findDirectAppstleMutations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(SCAN_ROOT)) {
    const rel = file.replace(/^\.\//, "");
    if (rel.includes(".test.")) continue;
    if (isAllowed(rel).allowed) continue;

    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const urlAt = line.search(APPSTLE_URL_RE);
      if (urlAt === -1) return;
      if (isProseLine(line, urlAt)) return;

      // Look for a mutating method on the same line or within the next
      // few lines (covers the `fetch(url, { method: "PUT", … })` shape).
      const windowEnd = Math.min(lines.length, i + METHOD_LOOKAHEAD_LINES + 1);
      for (let j = i; j < windowEnd; j++) {
        const m = lines[j].match(MUTATING_METHOD_RE);
        if (!m) continue;
        // Ignore a method match that is itself inside a `//` comment on
        // that line.
        const methodAt = lines[j].search(MUTATING_METHOD_RE);
        if (methodAt !== -1 && isProseLine(lines[j], methodAt)) continue;
        violations.push({ file: rel, line: i + 1, method: m[1], text: line.trim().slice(0, 120) });
        break;
      }
    });
  }
  return violations;
}

function main(): void {
  const violations = findDirectAppstleMutations();
  if (violations.length > 0) {
    console.error(
      `\n❌ check-no-direct-appstle-mutations — ${violations.length} raw Appstle vendor mutation(s):\n`,
    );
    for (const v of violations) {
      console.error(`   ${v.file}:${v.line}  method=${v.method}`);
      console.error(`      ${v.text}`);
    }
    console.error(
      `\n   A subscription is mutated through the commerce SDK` +
        `\n   (src/lib/commerce/subscription.ts), whose subscription* functions branch on` +
        `\n   isInternalSubscription() and dispatch to the internal writer or the vendor` +
        `\n   wrapper — never build a subscription-admin.appstle.com fetch by hand. If a` +
        `\n   genuinely vendor-only surface is needed, add the file to ALLOW_LIST in` +
        `\n   scripts/_check-no-direct-appstle-mutations.ts with a one-line reason first.\n`,
    );
    process.exit(1);
  }
  console.log("✅ check-no-direct-appstle-mutations — no raw Appstle vendor mutations outside the wrapper + SDK");
}

main();
