import type { PageData } from "../_lib/page-data";
import { ShopCTA } from "../_components/ShopCTA";

export function FinalCTASection({ data }: { data: PageData }) {
  const guarantee = data.page_content?.guarantee_copy;
  const lowestPrice = data.pricing_tiers.length
    ? Math.min(
        ...data.pricing_tiers.map(
          (t) => t.subscribe_price_cents ?? t.price_cents,
        ),
      )
    : null;

  return (
    <section
      data-section="final-cta"
      style={{ backgroundColor: "var(--storefront-primary)" }}
      className="w-full py-14 sm:py-20"
    >
      <div className="mx-auto max-w-3xl px-5 text-center md:px-8">
        <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl md:text-4xl">
          Ready to feel the difference?
        </h2>
        {guarantee && (
          <p className="mt-4 text-base text-zinc-300 sm:text-lg">{guarantee}</p>
        )}

        <div className="mt-8">
          <ShopCTA
            lowestPriceCents={lowestPrice}
            variant="inverse"
            align="center"
          />
        </div>

        <p className="mt-10 text-[11px] leading-relaxed text-zinc-500">
          {data.page_content?.fda_disclaimer ||
            "These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease."}
        </p>
      </div>
    </section>
  );
}
