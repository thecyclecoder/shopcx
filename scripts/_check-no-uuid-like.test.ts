/**
 * Unit tests for scripts/_check-no-uuid-like.ts — pins the spec's verification cases:
 *   - the three real Brittany lines flag (bare `id`, `member_id`, and a second `id` on subs).
 *   - the silent `.ilike("id", …)` from the authoring-lane probe flags.
 *   - a representative set of legitimate text-column matches do NOT flag
 *     (`description`, `body`, `discount_code`, `code`, `title`, `email`, `spec_slug`,
 *     `order_number`, `actor`, `outcome`, and the `*_id`-shaped text columns
 *     `shopify_contract_id` / `ticket_id`).
 *   - the escape hatch works.
 *   - a substring like `.likelihood("id"` does not match.
 *   - matches inside a `//` line comment or a `*` JSDoc continuation do not flag.
 *
 * Run:
 *   npm run test:no-uuid-like
 *   (= tsx --test scripts/_check-no-uuid-like.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { findUuidLikeCalls } from "./_check-no-uuid-like";

function scan(src: string) {
  return findUuidLikeCalls("virtual.ts", src);
}

test("scan: bare `.like(\"id\", ...)` on a uuid column flags", () => {
  const src = `
    await admin.from("subscriptions")
      .select("id").eq("workspace_id", ws)
      .like("id", \`\${PREFIX}%\`);
  `;
  const found = scan(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].method, "like");
  assert.equal(found[0].column, "id");
});

test("scan: silent `.ilike(\"id\", ...)` flags — the worse variant this spec closes", () => {
  const src = `
    await admin.from("agent_jobs")
      .select("id,kind").eq("workspace_id", WS)
      .ilike("id", \`\${BUILD}%\`).limit(1);
  `;
  const found = scan(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].method, "ilike");
  assert.equal(found[0].column, "id");
});

test("scan: the three Brittany lines from the spec all flag", () => {
  // The exact shape of the three offenders that shipped, sat unrun for two
  // days because every one of them threw at runtime.
  const src = `
    const { data: redRows } = await admin
      .from("loyalty_redemptions")
      .select("id, workspace_id, member_id, discount_code")
      .ilike("discount_code", CODE)
      .like("id", \`\${REDEMPTION_ID_PREFIX}%\`)
      .like("member_id", \`\${MEMBER_ID_PREFIX}%\`);

    const { data: subRows } = await admin
      .from("subscriptions")
      .select("id, workspace_id, applied_discounts")
      .eq("workspace_id", red.workspace_id)
      .like("id", \`\${SUB_ID_PREFIX}%\`);
  `;
  const found = scan(src);
  // Two `.like("id", …)` + one `.like("member_id", …)` — the `.ilike("discount_code", …)`
  // is a text column and must NOT flag.
  assert.equal(found.length, 3);
  const cols = found.map((f) => f.column).sort();
  assert.deepEqual(cols, ["id", "id", "member_id"]);
});

test("scan: legitimate text-column matches do NOT flag", () => {
  // A representative sweep of real text columns present in the repo. Any regression that
  // widens the guard to a blanket `_id` heuristic would fail this pin loudly.
  const src = `
    .ilike("description", "%foo%")
    .like("body", \`\${marker}%\`)
    .ilike("discount_code", CODE)
    .ilike("code", code)
    .ilike("derived_code", code)
    .ilike("title", "%amazing creamer%")
    .ilike("email", email)
    .ilike("spec_slug", "%advantage%age%")
    .ilike("order_number", \`\${PREFIX}%\`)
    .like("actor", "merge:%")
    .ilike("outcome", "saved_%")
    .ilike("purpose", "cx")
    .ilike("event_type", "spec_%")
    .ilike("instructions", "%build%")
    .ilike("error", "PR_RESOLVE%")
    .ilike("slot", "hero")
    .ilike("action_kind", "refund")
    .ilike("owner", "platform")
    .ilike("shopify_contract_id", "gid://%")
    .ilike("shopify_order_id", "gid://%")
    .ilike("shopify_customer_id", "gid://%")
    .ilike("shopify_return_gid", "gid://%")
    .ilike("meta_ad_id", "1234%")
    .ilike("ticket_id", "ext:%")
    .ilike("last_name", lastName)
    .ilike("phone", \`%\${pk}%\`)
    .ilike("name", "%foo%")
  `;
  assert.deepEqual(scan(src), []);
});

test("scan: escape hatch (`// uuid-like-ok:`) suppresses the flag", () => {
  const sameLine = `.like("id", "abc%") // uuid-like-ok: joined view column is text`;
  assert.deepEqual(scan(sameLine), []);

  const lineAbove = `
    // uuid-like-ok: joined view column is text
    .like("id", "abc%")
  `;
  assert.deepEqual(scan(lineAbove), []);
});

test("scan: `.likelihood(\"id\", …)` (substring) does NOT match", () => {
  const src = `probability.likelihood("id", 0.5)`;
  assert.deepEqual(scan(src), []);
});

test("scan: match inside a `//` line comment does NOT flag", () => {
  const src = `
    // Historical shape: was .like("id", prefix + "%") — replaced by .eq(FULL_UUID).
    doNothing();
  `;
  assert.deepEqual(scan(src), []);
});

test("scan: match inside a JSDoc `*` continuation does NOT flag", () => {
  const src = `
    /**
     * Anti-pattern: .like("id", prefix + "%") on a uuid column returns zero rows silently.
     */
    doNothing();
  `;
  assert.deepEqual(scan(src), []);
});

test("scan: each incident-seeded UUID column flags", () => {
  // Pins the full list — one line per column, so a regression that drops any of them
  // from UUID_COLUMNS fails this exact test with a legible per-column loss.
  const seeded = [
    "id",
    "member_id",
    "customer_id",
    "workspace_id",
    "spec_id",
    "phase_id",
    "subscription_id",
    "job_id",
  ];
  for (const col of seeded) {
    const src = `.ilike("${col}", "abc%")`;
    const found = scan(src);
    assert.equal(found.length, 1, `${col} should flag`);
    assert.equal(found[0].column, col);
  }
});

test("scan: template-literal column-name argument (backticks) also flags", () => {
  // Cover the third quote form our regex accepts — a backtick-quoted literal with no
  // interpolation is still a resolvable column name.
  const src = "await admin.from('t').select('*').like(`id`, 'abc%')";
  const found = scan(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].column, "id");
});
