/**
 * Unit tests for the function-mandate resolver (improve-tab-spec-author-auto-anchors-bare-function-
 * parent-to-mandate Phase 1). Pure — reads the on-disk `docs/brain/functions/{slug}.md` files but no DB.
 *
 * Run:
 *   npx tsx --test src/lib/function-mandates.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import path from "path";
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

// ── improve-tab-spec-author-auto-anchors-bare-function-parent-to-mandate Phase 3 ──────────────────
// The Improve-tab skill surfaces the CS mandate slugs to the box LLM so it can pick up front (Phase
// 3 makes the Phase 2 fallback rare rather than routine). Pin the skill's advertised slugs to the
// resolver's canonical output — if the CS charter is edited (heading text or {#slug} annotation) the
// SKILL.md must move with it. Same class as the [[../operational-rules]] "brain = spec" invariant.

test("ticket-improve skill's advertised CS mandate slugs match resolveFunctionMandates('cs') exactly", async () => {
  const skillPath = path.join(process.cwd(), ".claude", "skills", "ticket-improve", "SKILL.md");
  const skillMd = await fs.readFile(skillPath, "utf8");
  // The skill's `mandate` list is rendered as `` - `slug` `` bullet lines in the ticket_spec section.
  const advertised = new Set<string>();
  for (const line of skillMd.split("\n")) {
    const m = line.match(/^\s*-\s+`([a-z0-9][a-z0-9-]*)`\s+—/);
    if (m) advertised.add(m[1]);
  }
  const csMandates = await resolveFunctionMandates("cs");
  const actualSlugs = new Set(csMandates.map((m) => m.slug));
  // Every advertised slug must resolve to a real mandate — the executor validates the LLM's pick
  // against this set, and a stale doc would silently drop back to auto-anchor for the LLM's choice.
  for (const slug of advertised) {
    assert.ok(
      actualSlugs.has(slug),
      `SKILL.md advertises CS mandate slug "${slug}" but resolveFunctionMandates('cs') returned only [${[...actualSlugs].join(", ")}]`,
    );
  }
  // And every real CS mandate MUST be advertised — a new charter mandate the LLM doesn't know about
  // is the exact "fallback becomes routine" gap Phase 3 is closing.
  for (const slug of actualSlugs) {
    assert.ok(
      advertised.has(slug),
      `CS charter has mandate "${slug}" but the ticket-improve SKILL.md doesn't advertise it (add a - \`${slug}\` — … line under "Valid slugs on cs")`,
    );
  }
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
