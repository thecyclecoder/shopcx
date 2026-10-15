import { test } from "node:test";
import assert from "node:assert/strict";
import { hermeticTestEnv, STRIPPED_TEST_ENV_VARS } from "./_run-registered-tests";

test("hermeticTestEnv strips every Supabase credential so tests can never reach the real DB", () => {
  const env = hermeticTestEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "secret",
    SUPABASE_URL: "https://x.supabase.co",
    PATH: "/usr/bin",
  });
  for (const k of STRIPPED_TEST_ENV_VARS) assert.equal(env[k], undefined, k);
  assert.equal(env.PATH, "/usr/bin");
});

test("hermeticTestEnv does not mutate the input env", () => {
  const input = { SUPABASE_URL: "u" };
  hermeticTestEnv(input);
  assert.equal(input.SUPABASE_URL, "u");
});
