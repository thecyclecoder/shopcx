/**
 * Reopen-on-inbound regression pin — Phase 2 of
 * docs/brain/specs/sol-closes-ticket-on-resolving-reply-so-cora-grades-it.md.
 *
 * A ticket Sol closes (Phase 1 wire-in — status='closed', closed_at=now) must flip back to open
 * when the customer replies. Verification #2: "A customer inbound on a Sol-closed ticket reopens
 * it." This test pins the presence of the reopen block in each customer-inbound webhook path so
 * a future refactor that silently drops the block red-lights loudly instead of quietly leaving
 * Sol-closed tickets dead.
 *
 * The reopen path lives in per-channel webhook code (not a shared helper) — the pin is a source
 * inspection so it stays valid across in-file refactors that preserve the semantic while shifting
 * lines. Each pinned block must:
 *   - Read the ticket's current status.
 *   - Recognize both 'closed' and (for email/sms) 'pending' as reopen-worthy.
 *   - Reset status='open' AND closed_at=null on the reopen write.
 *
 * Run: npx tsx --test src/lib/sol-reopen-on-inbound.regression.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf-8");
}

test("reopen-on-inbound: email webhook flips a closed ticket back to open on customer reply", () => {
  const src = read("src/app/api/webhooks/email/route.ts");
  // The pinned block reopens BOTH closed and pending — closed is the Sol-close case, pending is
  // the operator-marked case; both flip back to open on customer inbound.
  assert.match(
    src,
    /ticket\.status\s*===\s*"pending"\s*\|\|\s*ticket\.status\s*===\s*"closed"/,
    "email webhook must check for pending|closed before reopening",
  );
  assert.match(
    src,
    /status:\s*"open"[\s,]*[\s\S]{0,120}?closed_at:\s*null/,
    "email webhook must set status='open' AND closed_at=null on reopen",
  );
});

test("reopen-on-inbound: sms webhook flips a closed ticket back to open on customer reply", () => {
  const src = read("src/app/api/webhooks/sms/route.ts");
  assert.match(
    src,
    /ticket\.status\s*===\s*"pending"\s*\|\|\s*ticket\.status\s*===\s*"closed"/,
    "sms webhook must check for pending|closed before reopening",
  );
  assert.match(
    src,
    /status\s*=\s*"open"[\s\S]{0,120}?closed_at\s*=\s*null/,
    "sms webhook must set status='open' AND closed_at=null on reopen",
  );
});

test("reopen-on-inbound: widget (live-chat) endpoint flips a closed ticket back to open on customer reply", () => {
  const src = read("src/app/api/widget/[workspaceId]/messages/route.ts");
  assert.match(
    src,
    /ticket\.status\s*===\s*"closed"/,
    "widget endpoint must recognize closed as reopen-worthy",
  );
  assert.match(
    src,
    /status:\s*"open"[\s\S]{0,80}?closed_at:\s*null/,
    "widget endpoint must set status='open' AND closed_at=null on reopen",
  );
});
