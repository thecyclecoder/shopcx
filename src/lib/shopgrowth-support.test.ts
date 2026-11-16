/**
 * software-mode-orchestrator-toolset — pure pieces of the ShopGrowth support client + the software-mode
 * orchestrator surface. Run: npx tsx --test src/lib/shopgrowth-support.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  storeKeyFromTags,
  resolveStoreKey,
  buildStoreReadUrl,
  compactBody,
  isForbiddenShopgrowthAction,
  isShopgrowthActionConfirmed,
} from "./shopgrowth-support";
import { toolNamesForMode, buildSoftwareSystemPrompt } from "./sonnet-orchestrator-v2";

test("store key comes from shop:/app: tags; ticket tags win over customer tags", () => {
  assert.deepEqual(storeKeyFromTags(["vip", "shop:acme.myshopify.com", "app:fraud-guard"]), { shop: "acme.myshopify.com", app: "fraud-guard" });
  assert.equal(storeKeyFromTags(["shop:acme.myshopify.com"]), null);
  assert.equal(storeKeyFromTags(null), null);
  assert.deepEqual(
    resolveStoreKey(["shop:a.myshopify.com", "app:x"], ["shop:b.myshopify.com", "app:y"]),
    { shop: "a.myshopify.com", app: "x" },
  );
  assert.deepEqual(resolveStoreKey([], ["shop:b.myshopify.com", "app:y"]), { shop: "b.myshopify.com", app: "y" });
});

test("read URLs map sections to ShopGrowth endpoints and carry shop + app", () => {
  const key = { shop: "acme.myshopify.com", app: "fraud-guard" };
  assert.match(buildStoreReadUrl("https://sg.test/", key, {}), /^https:\/\/sg\.test\/api\/support\/v1\/store\?shop=acme\.myshopify\.com&app=fraud-guard$/);
  assert.match(buildStoreReadUrl("https://sg.test", key, { section: "events", since: "2026-11-01" }), /\/api\/support\/v1\/events\?.*limit=50.*since=2026-11-01/);
  assert.match(buildStoreReadUrl("https://sg.test", key, { section: "order", order: "#1234" }), /\/api\/support\/v1\/orders\?.*order=%231234/);
  assert.match(buildStoreReadUrl("https://sg.test", key, { section: "chargebacks" }), /\/api\/support\/v1\/chargebacks\?/);
  // Unknown section falls back to the summary read; a model can't steer to another path.
  assert.match(buildStoreReadUrl("https://sg.test", key, { section: "../admin" }), /\/api\/support\/v1\/store\?/);
});

test("compactBody re-serializes JSON and caps length", () => {
  assert.equal(compactBody('{ "a": 1 }'), '{"a":1}');
  assert.match(compactBody("x".repeat(50), 10), /^x{10}… \[truncated\]$/);
});

test("plan, billing, uninstall and data deletion are never AI actions", () => {
  for (const a of ["change_plan", "cancel_billing", "uninstall_app", "delete_store_data", "gdpr_erase"]) {
    assert.equal(isForbiddenShopgrowthAction(a), true, a);
  }
  for (const a of ["release_order", "add_order_tag", "set_order_note", "cancel_order", "refund_order"]) {
    assert.equal(isForbiddenShopgrowthAction(a), false, a);
  }
});

test("an action runs only on a verbatim, affirmative confirmation in the latest message", () => {
  assert.equal(isShopgrowthActionConfirmed("Yes please release it, thanks!", "yes please release it"), true);
  assert.equal(isShopgrowthActionConfirmed("Go ahead", "go ahead"), true);
  // Quote not in the latest message (model paraphrased or hallucinated a yes).
  assert.equal(isShopgrowthActionConfirmed("hmm what would that do?", "yes"), false);
  // A refusal never counts, even if it contains the quoted words.
  assert.equal(isShopgrowthActionConfirmed("no, don't release it", "don't release it"), false);
  assert.equal(isShopgrowthActionConfirmed("", "yes"), false);
  assert.equal(isShopgrowthActionConfirmed("yes", ""), false);
});

test("software mode offers only the KB + store-read tools; cpg is unchanged", () => {
  assert.deepEqual(toolNamesForMode("software"), ["get_product_knowledge", "get_shopgrowth_store"]);
  const cpg = toolNamesForMode("cpg");
  assert.ok(cpg.includes("get_customer_account") && cpg.includes("get_product_knowledge"));
  assert.ok(!cpg.includes("get_shopgrowth_store"));
});

test("software prompt limits decision types and carries no CPG handlers", () => {
  const p = buildSoftwareSystemPrompt({ wsName: "ShopGrowth", persBlock: "Friendly.", policiesSection: "", promptSections: "" });
  assert.match(p, /"ai_response" \| "kb_response" \| "escalate" \| "shopgrowth_action"/);
  assert.match(p, /merchants/);
  assert.doesNotMatch(p, /Journeys \(on chat/);
  assert.doesNotMatch(p, /skip_next_order|bill_now/);
});
