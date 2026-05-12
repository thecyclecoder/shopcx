import type { PageData } from "../_lib/page-data";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * How we compare — two-column side-by-side, no separate "Feature" label.
 *
 * The product on the left, the generic alternative on the right. Each row
 * pair is positionally aligned so the customer reads them as opposites —
 * the feature is implied by the contrast (no need for a third column
 * naming it).
 *
 * Mobile and desktop use the same two-column grid; on mobile the cells
 * stack vertically within each column for breathing room.
 */
export function ComparisonSection({ data }: { data: PageData }) {
  const rows = data.page_content?.comparison_table_rows || [];
  if (rows.length === 0) return null;

  const productName = data.product.title;
  const lowestPrice = data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;

  return (
    <section data-section="comparison" className="w-full bg-zinc-50 py-12 sm:py-16">
      <div className="mx-auto max-w-4xl px-5 md:px-8">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:mb-10 md:text-4xl">
          How we compare
        </h2>

        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
          <div className="grid grid-cols-2">
            {/* Column headers. Intentionally not using the CTA primary
                color — that's reserved for actual click targets so it
                continues to pop. Dark neutral on our side, light on
                the alternative side, still gives a clear contrast. */}
            <div className="bg-zinc-900 px-4 py-4 text-center text-white sm:px-6 sm:py-5">
              <div className="text-base font-extrabold uppercase tracking-wide sm:text-lg">
                {productName}
              </div>
            </div>
            <div className="bg-zinc-100 px-4 py-4 text-center text-zinc-600 sm:px-6 sm:py-5">
              <div className="text-base font-semibold uppercase tracking-wide sm:text-lg">
                Regular Coffee
              </div>
            </div>

            {/* Rows — each row is two cells, one per column, positionally
                aligned. The grid layout ensures both cells in a pair are
                the same height even when the copy length differs. */}
            {rows.map((row, i) => (
              <ComparisonRow
                key={i}
                index={i}
                us={row.us}
                them={row.competitor_generic}
              />
            ))}
          </div>
        </div>

        <div className="mt-10 flex justify-center md:mt-14">
          <ShopCTA lowestPriceCents={lowestPrice} align="center" />
        </div>
      </div>
    </section>
  );
}

function ComparisonRow({
  index,
  us,
  them,
}: {
  index: number;
  us: string;
  them: string;
}) {
  // Subtle zebra striping so eyes can track row-pairs at a glance.
  const stripe = index % 2 === 0 ? "bg-white" : "bg-zinc-50/70";
  return (
    <>
      <div className={`${stripe} flex items-start gap-3 border-t border-zinc-100 px-4 py-4 sm:px-6 sm:py-5`}>
        <CheckIcon />
        <span className="text-base font-medium leading-snug text-zinc-900 sm:text-lg">
          {us}
        </span>
      </div>
      <div className={`${stripe} flex items-start gap-3 border-t border-l border-zinc-100 px-4 py-4 sm:px-6 sm:py-5`}>
        <XIcon />
        <span className="text-base leading-snug text-zinc-500 sm:text-lg">
          {them}
        </span>
      </div>
    </>
  );
}

function CheckIcon() {
  // Neutral emerald — universally read as "✓ correct/good" without
  // borrowing the CTA primary color (kept exclusive to click targets).
  return (
    <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  );
}

function XIcon() {
  return (
    <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </span>
  );
}
