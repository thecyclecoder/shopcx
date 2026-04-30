import type { PageData } from "../_lib/page-data";
import { LockIcon, ShieldIcon, TruckIcon } from "../_components/TrustBadge";

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

        <div className="mt-8 flex flex-col items-center gap-4">
          <a
            href="#pricing"
            className="inline-flex h-14 w-full max-w-sm items-center justify-center rounded-full bg-white px-8 text-base font-semibold text-zinc-900 transition-colors hover:bg-zinc-100"
          >
            {lowestPrice != null
              ? `Shop now — from $${(lowestPrice / 100).toFixed(2)}`
              : "Shop now"}
          </a>
          <div className="flex flex-wrap items-center justify-center gap-4 text-xs font-medium text-zinc-300">
            <span className="inline-flex items-center gap-1.5">
              <ShieldIcon /> 30-day guarantee
            </span>
            <span className="inline-flex items-center gap-1.5">
              <TruckIcon /> Free shipping
            </span>
            <span className="inline-flex items-center gap-1.5">
              <LockIcon /> Secure checkout
            </span>
          </div>
        </div>

        <p className="mt-10 text-[11px] leading-relaxed text-zinc-500">
          {data.page_content?.fda_disclaimer ||
            "These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease."}
        </p>
      </div>
    </section>
  );
}
