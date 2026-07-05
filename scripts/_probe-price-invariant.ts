/**
 * Probe: prove `priceSubscription` throws `PriceInvariantError` when a line's
 * price would be undefined — the failing state Phase 2 of
 * commerce-sdk-scaffold-money-resolver locks down.
 *
 * We synthesize an Appstle-baked sub (no DB — the Appstle branch of
 * `priceSubscription` uses baked line prices) with ONE product line that has
 * NO `price_cents`. Before Phase 2 that silently baked $0 into the total; the
 * invariant now throws.
 *
 * The probe exits 0 on the expected throw, 1 otherwise, so a CI wrap can gate
 * on `npx tsx scripts/_probe-price-invariant.ts` returning 0.
 */
import { priceSubscription, PriceInvariantError } from "@/lib/commerce/price";

const SYNTHETIC_SUB_ID = "00000000-0000-0000-0000-00000000cafe";
const MISSING_LINE_ID = "line-with-no-baked-price";

async function main() {
  const sub = {
    id: SYNTHETIC_SUB_ID,
    is_internal: false, // Appstle-baked branch — no DB needed
    workspace_id: "00000000-0000-0000-0000-000000000000",
    delivery_price_cents: 0,
    shipping_protection_added: false,
    shipping_protection_amount_cents: 0,
    applied_discounts: [],
    items: [
      {
        line_id: MISSING_LINE_ID,
        variant_id: "v-missing",
        title: "Superfoods Vanilla",
        quantity: 1,
        // NO price_cents — the failing state the invariant catches.
      },
    ],
  };

  try {
    await priceSubscription("00000000-0000-0000-0000-000000000000", sub as Record<string, unknown>);
  } catch (err) {
    if (err instanceof PriceInvariantError) {
      const msg = String(err.message);
      const hasSubId = msg.includes(SYNTHETIC_SUB_ID);
      const hasLineId = msg.includes(MISSING_LINE_ID);
      if (!hasSubId || !hasLineId) {
        console.error(
          `FAIL: PriceInvariantError thrown, but message must cite sub id + line id.\n  message: ${msg}`,
        );
        process.exit(1);
      }
      console.log(
        `PASS: PriceInvariantError thrown as expected — sub=${SYNTHETIC_SUB_ID} line=${MISSING_LINE_ID}`,
      );
      return;
    }
    console.error(`FAIL: unexpected error type (${(err as Error)?.constructor?.name}): ${err}`);
    process.exit(1);
  }

  console.error(
    `FAIL: expected PriceInvariantError, but priceSubscription returned normally — the invariant is missing`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
