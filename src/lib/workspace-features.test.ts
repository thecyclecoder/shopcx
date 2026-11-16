import { test } from "node:test";
import assert from "node:assert/strict";
import { hasWorkspaceFeature, featureForHref } from "./workspace-features";

test("null enabled_features grants every feature (Superfoods default)", () => {
  assert.equal(hasWorkspaceFeature(null, "tickets"), true);
  assert.equal(hasWorkspaceFeature(null, "analytics"), true);
  assert.equal(hasWorkspaceFeature(null, "anything"), true);
});

test("settings is always enabled regardless of the allow-list", () => {
  assert.equal(hasWorkspaceFeature([], "settings"), true);
  assert.equal(hasWorkspaceFeature(["tickets"], "settings"), true);
  assert.equal(hasWorkspaceFeature(null, "settings"), true);
});

test("an allow-list enables only its members (ShopGrowth = tickets only)", () => {
  const shopgrowth = ["tickets"];
  assert.equal(hasWorkspaceFeature(shopgrowth, "tickets"), true);
  assert.equal(hasWorkspaceFeature(shopgrowth, "customers"), false);
  assert.equal(hasWorkspaceFeature(shopgrowth, "analytics"), false);
  assert.equal(hasWorkspaceFeature(shopgrowth, "dashboard"), false);
});

test("empty allow-list enables nothing except settings", () => {
  assert.equal(hasWorkspaceFeature([], "tickets"), false);
  assert.equal(hasWorkspaceFeature([], "settings"), true);
});

test("featureForHref derives the first segment after /dashboard", () => {
  assert.equal(featureForHref("/dashboard"), "dashboard");
  assert.equal(featureForHref("/dashboard/tickets"), "tickets");
  assert.equal(featureForHref("/dashboard/tickets/escalated"), "tickets");
  assert.equal(featureForHref("/dashboard/marketing/text"), "marketing");
  assert.equal(featureForHref("/dashboard/knowledge-base"), "knowledge-base");
  assert.equal(featureForHref("/dashboard/settings"), "settings");
});

test("featureForHref returns null for non-gated hrefs", () => {
  assert.equal(featureForHref("#"), null);
  assert.equal(featureForHref(""), null);
  assert.equal(featureForHref("/showcase"), null);
});
