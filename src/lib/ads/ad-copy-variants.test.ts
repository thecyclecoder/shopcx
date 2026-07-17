/**
 * ad-copy-variants tests — pins the writeCopyVariants SDK chokepoint + the pickCanonicalVariant
 * warm > cold > hot priority. All four cases hit a fake admin client that records the upsert
 * body (or its lack) so this is a pure unit test — no supabase pooler, no network.
 *
 * Runs via: npx tsx --test src/lib/ads/ad-copy-variants.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeCopyVariants } from "./ad-copy-variants";
import { pickCanonicalVariant, type AuthorModeCopyVariant } from "./creative-agent";

// Baseline variant scaffolding — good self-score + green validator + a plausible claim-trace
// so the SDK's row shape is exercised end-to-end. `retryIndex` omitted so we also pin the
// `retry_index=0` default.
function makeVariant(band: "cold" | "warm" | "hot"): AuthorModeCopyVariant {
  return {
    audience_temperature: band,
    headline: `${band} headline`,
    primaryText: `${band} primary text — a plausible caption for ${band}-audience routing.`,
    description: `${band} description`,
    selfScore: {
      lf8: 2,
      schwartz: 2,
      cialdini: 1,
      hopkins: 2,
      sugarman: 1,
      total: 8,
      evidence: [`${band}: routed for the ${band}-audience selector`],
    },
    claim_trace: [{ claim: "cleaner energy", source: "reviews.byClaim", source_ref: "review-42" }],
    concept_tag: "curiosity",
    validatorPass: true,
    validatorChecks: [{ rail: "lf8", pass: true }],
  };
}

interface CapturedUpsert {
  table: string;
  rows: Array<Record<string, unknown>>;
  opts: { onConflict?: string };
}

/** Fake admin — accumulates one CapturedUpsert per `.upsert(...)` call so a repeat-write test
 *  can pin the second upsert independently. `.select("id")` returns one id per row. */
function makeFakeAdmin(): { admin: unknown; captured: CapturedUpsert[] } {
  const captured: CapturedUpsert[] = [];
  const admin = {
    from(table: string) {
      return {
        upsert(rows: Array<Record<string, unknown>>, opts: { onConflict?: string }) {
          const record: CapturedUpsert = { table, rows, opts };
          captured.push(record);
          return {
            select(_cols: string) {
              return Promise.resolve({
                data: rows.map((_, i) => ({ id: `variant-${captured.length}-${i}` })),
                error: null,
              });
            },
          };
        },
      };
    },
  };
  return { admin, captured };
}

test("(a) empty variants → 0 rows written, no throw", async () => {
  const { admin, captured } = makeFakeAdmin();
  const result = await writeCopyVariants(admin as never, {
    adCampaignId: "camp-empty",
    workspaceId: "ws-1",
    variants: [],
  });
  assert.deepEqual(result, { inserted: 0 });
  assert.equal(captured.length, 0, "empty variants must not call the admin client at all");
});

test("(b) 3 variants → 3 rows, one per band, with the on-conflict target the UNIQUE names", async () => {
  const { admin, captured } = makeFakeAdmin();
  const variants = [makeVariant("cold"), makeVariant("warm"), makeVariant("hot")];
  const result = await writeCopyVariants(admin as never, {
    adCampaignId: "camp-1",
    workspaceId: "ws-1",
    variants,
  });
  assert.deepEqual(result, { inserted: 3 });
  assert.equal(captured.length, 1);
  const call = captured[0];
  assert.equal(call.table, "ad_creative_copy_variants");
  assert.equal(call.opts.onConflict, "ad_campaign_id,audience_temperature");
  assert.equal(call.rows.length, 3);
  const bands = call.rows.map((r) => r.audience_temperature).sort();
  assert.deepEqual(bands, ["cold", "hot", "warm"]);
  for (const row of call.rows) {
    assert.equal(row.workspace_id, "ws-1");
    assert.equal(row.ad_campaign_id, "camp-1");
    assert.equal(row.validator_pass, true);
    assert.equal(row.retry_index, 0);
    assert.equal(typeof row.headline, "string");
    assert.equal(typeof row.primary_text, "string");
    assert.equal(typeof row.description, "string");
    assert.ok(row.author_self_score);
    assert.ok(row.claim_trace);
    assert.ok(row.validator_checks);
    assert.equal(row.concept_tag, "curiosity");
  }
});

test("(c) re-writing the same pack is idempotent by upsert on the UNIQUE — 3 rows both times", async () => {
  const { admin, captured } = makeFakeAdmin();
  const variants = [makeVariant("cold"), makeVariant("warm"), makeVariant("hot")];
  const r1 = await writeCopyVariants(admin as never, {
    adCampaignId: "camp-1",
    workspaceId: "ws-1",
    variants,
  });
  const r2 = await writeCopyVariants(admin as never, {
    adCampaignId: "camp-1",
    workspaceId: "ws-1",
    variants,
  });
  assert.deepEqual(r1, { inserted: 3 });
  assert.deepEqual(r2, { inserted: 3 });
  assert.equal(captured.length, 2, "each call issues one upsert");
  // Both upserts target the same on-conflict pair — that's what makes the write idempotent at
  // the DB level (the second upsert overwrites the first row, no dupes).
  assert.equal(captured[0].opts.onConflict, "ad_campaign_id,audience_temperature");
  assert.equal(captured[1].opts.onConflict, "ad_campaign_id,audience_temperature");
});

test("(d) pickCanonicalVariant follows warm > cold > hot priority", () => {
  const cold = makeVariant("cold");
  const warm = makeVariant("warm");
  const hot = makeVariant("hot");

  // All three present → warm wins.
  assert.equal(pickCanonicalVariant([cold, warm, hot])?.audience_temperature, "warm");
  // Warm missing → cold wins over hot.
  assert.equal(pickCanonicalVariant([cold, hot])?.audience_temperature, "cold");
  // Only hot → hot.
  assert.equal(pickCanonicalVariant([hot])?.audience_temperature, "hot");
  // Only warm → warm.
  assert.equal(pickCanonicalVariant([warm])?.audience_temperature, "warm");
  // Empty → null.
  assert.equal(pickCanonicalVariant([]), null);
});

test("(e) a driver error → throws, so the caller can escalate rather than silently drop the pack", async () => {
  // Bespoke fake — the upsert path returns { error } so writeCopyVariants must throw.
  const brokenAdmin = {
    from(_table: string) {
      return {
        upsert(_rows: Array<Record<string, unknown>>, _opts: { onConflict?: string }) {
          return {
            select(_cols: string) {
              return Promise.resolve({ data: null, error: { message: "unique_violation" } });
            },
          };
        },
      };
    },
  };
  await assert.rejects(
    writeCopyVariants(brokenAdmin as never, {
      adCampaignId: "camp-broken",
      workspaceId: "ws-1",
      variants: [makeVariant("warm")],
    }),
    /writeCopyVariants: upsert failed for ad_campaign_id=camp-broken/,
  );
});
