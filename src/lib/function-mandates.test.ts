/**
 * Unit tests for the function-mandate resolver (improve-tab-spec-author-auto-anchors-bare-function-
 * parent-to-mandate Phase 1). Pure — reads the on-disk `docs/brain/functions/{slug}.md` files but no DB.
 *
 * Run:
 *   npx tsx --test src/lib/function-mandates.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseFunctionMandates, resolveFunctionMandates } from "./function-mandates";

test("resolveFunctionMandates('platform') returns exactly the three platform mandates with the expected slugs", async () => {
  const ms = await resolveFunctionMandates("platform");
  assert.equal(ms.length, 3, `expected 3 platform mandates, got ${ms.length}: ${ms.map((m) => m.slug).join(",")}`);
  const slugs = ms.map((m) => m.slug);
  assert.deepEqual(slugs, ["build", "store-tech-shopify", "infra-devops-reliability"]);
  const headings = ms.map((m) => m.heading);
  assert.deepEqual(headings, ["Autonomous build platform", "Store tech / Shopify", "Infra & DevOps / reliability"]);
  // Each mandate carries body prose (the paragraph under its heading) — used by the best-fit chooser.
  for (const m of ms) {
    assert.ok(m.body.length > 0, `mandate ${m.slug} carries no body prose`);
  }
});

test("resolveFunctionMandates('unknown-function-slug') returns []", async () => {
  const ms = await resolveFunctionMandates("this-function-does-not-exist");
  assert.deepEqual(ms, []);
});

test("resolveFunctionMandates('') / an invalid slug returns []", async () => {
  assert.deepEqual(await resolveFunctionMandates(""), []);
  assert.deepEqual(await resolveFunctionMandates("../etc/passwd"), []);
});

test("parseFunctionMandates handles a file with no `## Mandates` section by returning []", () => {
  const raw = "# Some function\n\nSome scope text.\n\n## Owned goals\n- foo\n";
  assert.deepEqual(parseFunctionMandates(raw), []);
});

test("parseFunctionMandates falls back to kebab-case for a heading with no {#slug} anchor", () => {
  const raw = [
    "# fn",
    "## Mandates",
    "### Store tech / Shopify",
    "Body A.",
    "### Infra & DevOps / reliability",
    "Body B.",
    "## Next section",
    "Not a mandate.",
  ].join("\n");
  const ms = parseFunctionMandates(raw);
  assert.equal(ms.length, 2);
  assert.equal(ms[0].slug, "store-tech-shopify");
  assert.equal(ms[0].heading, "Store tech / Shopify");
  assert.match(ms[0].body, /Body A/);
  assert.equal(ms[1].slug, "infra-devops-reliability");
  assert.equal(ms[1].heading, "Infra & DevOps / reliability");
  assert.match(ms[1].body, /Body B/);
});

test("parseFunctionMandates honors an explicit {#slug} anchor over the kebab fallback", () => {
  const raw = [
    "# fn",
    "## Mandates (perpetual)",
    "### Autonomous build platform {#build}",
    "Body of the build mandate.",
    "### Store tech / Shopify",
    "Body of the store-tech mandate.",
  ].join("\n");
  const ms = parseFunctionMandates(raw);
  assert.equal(ms.length, 2);
  assert.equal(ms[0].slug, "build");
  assert.equal(ms[0].heading, "Autonomous build platform"); // annotation stripped
  assert.equal(ms[1].slug, "store-tech-shopify");
});

test("parseFunctionMandates stops at the next `## ` section — subsequent H3s are NOT captured", () => {
  const raw = [
    "## Mandates",
    "### A",
    "body a",
    "## What the director does",
    "### Auto-approves an X",
    "not a mandate — this is under a different section",
  ].join("\n");
  const ms = parseFunctionMandates(raw);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].slug, "a");
});
