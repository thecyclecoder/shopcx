/**
 * pickContractRefRow — which subscription a contract id REFERS TO when it may be a
 * pre-migration id. Ground truth: a migrated customer's old Appstle id (from a cancel-journey
 * snapshot, a cached portal, ticket history, an exhausted dunning cycle) used to match nothing,
 * and every engine router defaulted to Appstle — a cancel "succeeded" on the dead contract while
 * Braintree kept billing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickContractRefRow } from "./internal-subscription";

type R = {
  name: string;
  shopify_contract_id: string | null;
  migrated_from_contract_id: string | null;
  is_internal: boolean | null;
  status: string | null;
  created_at: string | null;
};
const row = (o: Partial<R> & { name: string }): R => ({
  shopify_contract_id: null, migrated_from_contract_id: null, is_internal: false, status: "active", created_at: "2026-06-01T00:00:00Z", ...o,
});
const OLD = "33357988013";

test("old Appstle id with only the migrated row → the migrated internal row", () => {
  const migrated = row({ name: "migrated", shopify_contract_id: "internal-cd61", migrated_from_contract_id: OLD, is_internal: true });
  assert.equal(pickContractRefRow([migrated], OLD)?.name, "migrated");
});

test("a live (un-migrated) row holding the id as current wins", () => {
  const live = row({ name: "live", shopify_contract_id: OLD });
  assert.equal(pickContractRefRow([live], OLD)?.name, "live");
});

test("mid-migration (pre-marked: both columns equal the id) → that row, as CURRENT", () => {
  const premarked = row({ name: "premarked", shopify_contract_id: OLD, migrated_from_contract_id: OLD });
  assert.equal(pickContractRefRow([premarked], OLD)?.name, "premarked");
});

test("dead cancelled vendor shell + migrated row → the migrated row (Ellyn / ticket 183d28b9 shape)", () => {
  const shell = row({ name: "shell", shopify_contract_id: OLD, status: "cancelled", is_internal: false, created_at: "2026-09-21T00:00:00Z" });
  const migrated = row({ name: "migrated", shopify_contract_id: "internal-cd61", migrated_from_contract_id: OLD, is_internal: true });
  assert.equal(pickContractRefRow([shell, migrated], OLD)?.name, "migrated");
});

test("a current row that is NOT a dead shell beats a migrated claimant", () => {
  const liveCurrent = row({ name: "current", shopify_contract_id: OLD, status: "active" });
  const migrated = row({ name: "migrated", shopify_contract_id: "internal-x", migrated_from_contract_id: OLD, is_internal: true });
  assert.equal(pickContractRefRow([liveCurrent, migrated], OLD)?.name, "current");
});

test("several migrated claimants → internal first, then live, then newest", () => {
  const shopcxLive = row({ name: "shopcx", shopify_contract_id: "8123", migrated_from_contract_id: OLD, is_internal: false, status: "active", created_at: "2026-09-30T00:00:00Z" });
  const internalCancelled = row({ name: "int-cancelled", shopify_contract_id: "internal-a", migrated_from_contract_id: OLD, is_internal: true, status: "cancelled", created_at: "2026-07-01T00:00:00Z" });
  const internalLive = row({ name: "int-live", shopify_contract_id: "internal-b", migrated_from_contract_id: OLD, is_internal: true, status: "active", created_at: "2026-06-01T00:00:00Z" });
  assert.equal(pickContractRefRow([shopcxLive, internalCancelled, internalLive], OLD)?.name, "int-live");
});

test("nothing claims the id → null (callers keep the input; routers keep their default)", () => {
  assert.equal(pickContractRefRow([row({ name: "other", shopify_contract_id: "999" })], OLD), null);
  assert.equal(pickContractRefRow([], OLD), null);
});
