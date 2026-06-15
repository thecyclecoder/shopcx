import type { PageData } from "../_lib/page-data";
import { weightLossReviews, displayReviewCount } from "@/lib/advertorial-pages";

/**
 * Wall of weight-loss / appearance testimonials for the before/after lander —
 * real 5★ reviews filtered to the CORE desires (weight, looking younger, getting
 * noticed). Closes the transformation scent with proof before the price table.
 * Specific numbers are allowed HERE because they're real customer quotes.
 */
function Stars({ n }: { n: number }) {
  const full = Math.max(0, Math.min(5, Math.round(n)));
  return (
    <span aria-label={`${full} of 5`} style={{ color: "#E8A100", letterSpacing: 1 }}>
      {"★".repeat(full)}
    </span>
  );
}

export function WeightLossTestimonialWall({ data }: { data: PageData }) {
  const reviews = weightLossReviews(data.reviews, 9);
  if (!reviews.length) return null;
  return (
    <section data-section="testimonial-wall" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-5 md:px-8">
        <h2 className="text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl">
          Real results, in their own words
        </h2>
        <p className="mt-2 text-center text-sm text-zinc-500">
          From {displayReviewCount(data.review_total_count || 0)} verified reviews
        </p>

        <div className="mt-8 columns-1 gap-5 sm:columns-2 lg:columns-3">
          {reviews.map((r) => (
            <figure key={r.id} className="mb-5 break-inside-avoid rounded-2xl border border-zinc-200 bg-zinc-50 p-5">
              <Stars n={r.rating ?? 5} />
              <blockquote className="mt-2 text-[15px] leading-relaxed text-zinc-800">
                {r.smart_quote || r.body}
              </blockquote>
              <figcaption className="mt-3 flex items-center gap-2 text-sm font-semibold text-zinc-900">
                {r.reviewer_name || "Verified Customer"}
                <span className="inline-flex items-center gap-1 text-xs font-bold" style={{ color: "#1B8A4B" }}>
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#1B8A4B] text-[10px] text-white">✓</span>
                  Verified
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
