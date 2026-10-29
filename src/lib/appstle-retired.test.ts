/**
 * Unit tests for the `appstle_retired` switch (src/lib/appstle-retired.ts).
 *
 * With the switch ON every Appstle wrapper must throw `AppstleRetiredError` BEFORE any request or
 * DB read — so a path the chokepoint missed fails loudly instead of calling a vendor that is gone —
 * and the scheduled Appstle-only callers (sweeper, snapshot puller, executeMigration) skip cleanly.
 * With the switch OFF nothing changes.
 *
 * The switch is forced with the test seam `_setAppstleRetiredForTests`; no Supabase, no network.
 * A global fetch trap records any request so "threw before calling Appstle" is asserted, not hoped.
 *
 * Run: npm run test:appstle-retired
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  AppstleRetiredError,
  APPSTLE_RETIRED_SWITCH,
  _setAppstleRetiredForTests,
  assertAppstleLive,
  isAppstleRetired,
  isAppstleRetiredError,
} from "./appstle-retired";

const WS = "11111111-1111-1111-1111-111111111111";
const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];

test.before(() => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    throw new Error(`network call in a unit test: ${String(url)}`);
  }) as typeof fetch;
});
test.after(() => {
  globalThis.fetch = realFetch;
  _setAppstleRetiredForTests(null);
});
test.beforeEach(() => {
  fetchCalls.length = 0;
});

test("switch id is appstle_retired", () => {
  assert.equal(APPSTLE_RETIRED_SWITCH, "appstle_retired");
});

test("assertAppstleLive: throws a typed AppstleRetiredError when on, passes when off", async () => {
  _setAppstleRetiredForTests(true);
  assert.equal(await isAppstleRetired(), true);
  await assert.rejects(assertAppstleLive("here"), (e: unknown) => {
    assert.ok(e instanceof AppstleRetiredError);
    assert.ok(isAppstleRetiredError(e));
    assert.match((e as Error).message, /appstle_retired.*here/);
    return true;
  });
  _setAppstleRetiredForTests(false);
  await assertAppstleLive("here");
});

test("getAppstleCredentials (every appstle.ts wrapper's first call) throws when retired — before any read", async () => {
  _setAppstleRetiredForTests(true);
  const { getAppstleCredentials, appstleCancelContractVendorOnly } = await import("./appstle");
  await assert.rejects(getAppstleCredentials(WS), AppstleRetiredError);
  await assert.rejects(appstleCancelContractVendorOnly(WS, "27000000001"), AppstleRetiredError);
  assert.deepEqual(fetchCalls, []);
});

test("getAppstleConfig (subscription-items' Appstle arm) throws when retired", async () => {
  _setAppstleRetiredForTests(true);
  const { getAppstleConfig, resolveContractVariantId } = await import("./subscription-items");
  await assert.rejects(getAppstleConfig(WS), AppstleRetiredError);
  await assert.rejects(resolveContractVariantId(WS, "27000000001", "123"), AppstleRetiredError);
  assert.deepEqual(fetchCalls, []);
});

test("loggedAppstleFetch (lowest common Appstle fetch) throws for appstle.com, never sends", async () => {
  _setAppstleRetiredForTests(true);
  const { loggedAppstleFetch } = await import("./appstle-call-log");
  await assert.rejects(
    loggedAppstleFetch("https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-skip?contractId=1", { method: "PUT" }),
    AppstleRetiredError,
  );
  assert.deepEqual(fetchCalls, []);
});

test("fetchAppstleContract throws; snapshotAppstleContract SKIPS cleanly and writes nothing", async () => {
  _setAppstleRetiredForTests(true);
  const { fetchAppstleContract, snapshotAppstleContract } = await import("./appstle-snapshot");
  await assert.rejects(fetchAppstleContract(WS, "27000000001"), AppstleRetiredError);
  const r = await snapshotAppstleContract(WS, "27000000001", null);
  assert.deepEqual(r, { ok: false, skipped: true, error: "appstle_retired — snapshot skipped" });
  assert.deepEqual(fetchCalls, []);
});

test("sweepIncompleteMigrations + executeMigration skip cleanly (no Appstle, no DB, no throw)", async () => {
  _setAppstleRetiredForTests(true);
  const { sweepIncompleteMigrations, executeMigration } = await import("./commerce/shopify-subscription-migrate");
  assert.deepEqual(await sweepIncompleteMigrations(WS, { apply: true }), []);
  const r = await executeMigration(WS, "27000000001", {} as never, { completeSwap: true });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "appstle-retired");
  assert.deepEqual(fetchCalls, []);
});

test("switch OFF: the wrapper gate is open (a missing credential, not a retired error)", async () => {
  _setAppstleRetiredForTests(false);
  const { loggedAppstleFetch } = await import("./appstle-call-log");
  // Gate passes → the (trapped) fetch is actually attempted — i.e. behaviour is unchanged.
  await assert.rejects(loggedAppstleFetch("https://subscription-admin.appstle.com/x"), (e: unknown) => !isAppstleRetiredError(e));
  assert.equal(fetchCalls.length, 1);
});
