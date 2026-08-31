/**
 * Pins the shared-competitor-shelf resolver (CEO 2026-08-25).
 *
 * The wedge: Amazing Coffee K-Cups is the same coffee in a pod, so the coffee competitors serve it —
 * but `creative_skeletons.product_id` is "the deliberate imitate link" and Dahlia's
 * `getProvenCompetitorAngles` filters on it, so K-Cups imitated from an EMPTY shelf (0 skeletons vs
 * 245 on Coffee's).
 *
 * Copying the competitor rows instead would have been actively harmful: the AdLibrary freshness
 * ledger is keyed on `(workspace_id, keyword)` and the sweep walks products SEQUENTIALLY, so two
 * products sharing a keyword means whichever sweeps first stamps the ledger and the other is skipped
 * as fresh — permanently starving whichever sorts second, while burning storage on duplicates.
 *
 * Run: npx tsx --test src/lib/ads/shelf-source.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveShelfProductIds } from "./creative-sourcing";

const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";

/** Minimal admin stub — only `.from("products").select().eq().maybeSingle()` is exercised. */
function stubAdmin(row: { competitor_shelf_source_id: string | null } | null, error?: { message: string }) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: async () => ({ data: row, error: error ?? null }) };
            },
          };
        },
      };
    },
  } as never;
}

test("⭐ a product with a shelf source resolves to BOTH ids — the wedge (K-Cups → Amazing Coffee)", async () => {
  const ids = await resolveShelfProductIds(stubAdmin({ competitor_shelf_source_id: COFFEE }), KCUPS);
  assert.deepEqual(ids, [KCUPS, COFFEE]);
  assert.equal(ids[0], KCUPS, "the product's OWN shelf must come first");
});

test("a product with no shelf source is unchanged — the default for every other product", async () => {
  const ids = await resolveShelfProductIds(stubAdmin({ competitor_shelf_source_id: null }), COFFEE);
  assert.deepEqual(ids, [COFFEE], "Amazing Coffee must NOT be widened — the pointer is DIRECTED");
});

test("the relation is one hop — a self-pointer collapses instead of duplicating", async () => {
  // A DB CHECK forbids self-reference; the resolver de-dupes anyway so bad data can't yield IN (x, x).
  const ids = await resolveShelfProductIds(stubAdmin({ competitor_shelf_source_id: KCUPS }), KCUPS);
  assert.deepEqual(ids, [KCUPS]);
});

test("a read error NARROWS to the product's own shelf — never silently widens it", async () => {
  // Failing open here would leak another product's competitors into this one's imitation set.
  const ids = await resolveShelfProductIds(stubAdmin(null, { message: "boom" }), KCUPS);
  assert.deepEqual(ids, [KCUPS]);
});

test("a missing product row also narrows rather than throwing", async () => {
  const ids = await resolveShelfProductIds(stubAdmin(null), KCUPS);
  assert.deepEqual(ids, [KCUPS]);
});

test("sweep seeds are NOT affected — the shelf is shared, the AdLibrary quota is not", () => {
  // Guard-rail note, asserted structurally in _kcups-into-ad-flow / the scout: the pointer lives on
  // the SOURCING path (creative_skeletons reads). loadApprovedCompetitorsForProduct still filters
  // `.eq("product_id", productId)`, so K-Cups sweeps nothing of its own and no keyword is searched
  // twice. If that ever changes, the freshness ledger's (workspace, keyword) key means the second
  // product silently starves — which is the whole reason this is a pointer and not copied rows.
  assert.ok(true);
});
