/**
 * Named failing state: `next.config.ts` does NOT set `experimental.authInterrupts: true`
 * while a `src/` file imports `forbidden` from `next/navigation` (the state that produced
 * error signature `vercel:68f6fc9180f7730f`).
 *
 * These tests pin the guard's core predicate — enable→pass, disable→fail — so a future
 * config edit that drops the flag cannot silently regress the storefront blueprint gate.
 *
 * Run:  npx tsx --test scripts/_check-authinterrupts-when-forbidden-imported.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");
const NEXT_CONFIG = join(REPO_ROOT, "next.config.ts");

const experimentalBlockRe = /experimental\s*:\s*\{([\s\S]*?)\}/;
const authInterruptsTrueRe = /\bauthInterrupts\s*:\s*true\b/;

function extractExperimentalBody(src: string): string | null {
  const m = experimentalBlockRe.exec(src);
  return m ? m[1] : null;
}

test("next.config.ts declares an experimental block", () => {
  const src = readFileSync(NEXT_CONFIG, "utf8");
  const body = extractExperimentalBody(src);
  assert.notStrictEqual(
    body,
    null,
    "next.config.ts must expose an `experimental: { ... }` block so authInterrupts can be enabled",
  );
});

test("next.config.ts sets experimental.authInterrupts = true", () => {
  const src = readFileSync(NEXT_CONFIG, "utf8");
  const body = extractExperimentalBody(src);
  assert.ok(body, "expected an experimental block in next.config.ts");
  assert.match(
    body!,
    authInterruptsTrueRe,
    "next.config.ts must set experimental.authInterrupts=true — required for forbidden() calls in the storefront blueprint PDP gate to render a real 403 instead of throwing a runtime error",
  );
});

test("the failing-state pin: dropping authInterrupts is detected", () => {
  // Simulates the pre-fix state — an experimental block with the flag missing —
  // and asserts the same regex the guard uses would NOT accept it.
  const withoutFlag = `
    const nextConfig = {
      experimental: {
        someOtherFlag: true,
      },
    };
  `;
  const body = extractExperimentalBody(withoutFlag);
  assert.ok(body, "extractor should still find the block");
  assert.ok(
    !authInterruptsTrueRe.test(body!),
    "guard predicate must reject an experimental block that omits authInterrupts",
  );
});
