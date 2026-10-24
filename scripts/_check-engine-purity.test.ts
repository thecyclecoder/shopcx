/**
 * Unit tests for scripts/_check-engine-purity.ts — the engine folder must stay
 * liftable into the shared ShopCX/ShopGrowth package.
 *
 * Run:
 *   npm run test:engine-purity
 *   (= tsx --test scripts/_check-engine-purity.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "path";

import { findEngineImpurities } from "./_check-engine-purity";

const ROOT = resolve("src/lib/engine");
const FILE = "src/lib/engine/fraud/rules.ts";
const scan = (src: string) => findEngineImpurities(FILE, src, ROOT).map((v) => v.reason);

test("pure code with in-folder and allow-listed imports passes", () => {
  const src = `
    import { normalizeAddress } from "../normalize/address";
    import zipcodes from "zipcodes";
    import list from "./freemail-domains.json";
    export function score(now: Date) { return now.getTime(); }
  `;
  assert.deepEqual(scan(src), []);
});

test("ShopCX @/ imports flag", () => {
  assert.equal(scan(`import { createAdminClient } from "@/lib/supabase/admin";`).length, 1);
});

test("relative import escaping the engine flags", () => {
  assert.match(scan(`import { x } from "../../fraud-detector";`)[0], /escapes/);
});

test("non-allow-listed packages flag, including dynamic import and require", () => {
  assert.equal(scan(`import { createClient } from "@supabase/supabase-js";`).length, 1);
  assert.equal(scan(`const m = await import("inngest");`).length, 1);
  assert.equal(scan(`const fs = require("fs");`).length, 1);
});

test("env, network, clock and randomness flag", () => {
  assert.equal(scan(`const k = process.env.ANTHROPIC_API_KEY;`).length, 1);
  assert.equal(scan(`await fetch("https://api.anthropic.com/v1/messages");`).length, 1);
  assert.equal(scan(`const t = Date.now();`).length, 1);
  assert.equal(scan(`const d = new Date();`).length, 1);
  assert.equal(scan(`const r = Math.random();`).length, 1);
});

test("new Date(value) and prose in comments do not flag", () => {
  const src = `
    // never call fetch() or Date.now() in here
    /* process.env is read by the caller */
    export const parse = (iso: string) => new Date(iso);
  `;
  assert.deepEqual(scan(src), []);
});
