import type { PageData } from "../_lib/page-data";
import { ImageOrPlaceholder } from "../_components/ImageOrPlaceholder";

/**
 * Ingredients deep dive. Uses native <details>/<summary> for the expand/
 * collapse so no JS is needed.
 */
export function IngredientsSection({ data }: { data: PageData }) {
  // Show ingredients that have at least one research row tied to a
  // lead/supporting benefit selection. Fall back to all if nothing's been
  // reconciled yet.
  const ingredients = data.ingredients;
  if (ingredients.length === 0) return null;

  const researchById = new Map<string, typeof data.ingredient_research>();
  for (const r of data.ingredient_research) {
    const list = researchById.get(r.ingredient_id) || [];
    list.push(r);
    researchById.set(r.ingredient_id, list);
  }

  return (
    <section data-section="ingredients" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-5 md:px-8">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-4xl">
          Inside every serving
        </h2>
        <div className="space-y-3 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
          {ingredients.map((ing) => {
            const research = researchById.get(ing.id) || [];
            const topBenefit = research.sort((a, b) => b.ai_confidence - a.ai_confidence)[0];
            const slot = `ingredient_${ing.name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")}`;
            const image = data.media_by_slot[slot];

            return (
              <details
                key={ing.id}
                className="group rounded-2xl border border-zinc-200 bg-white p-5 [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex cursor-pointer list-none items-start justify-between gap-4">
                  <div className="flex flex-1 items-start gap-4">
                    <div
                      className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-xl"
                      style={{ aspectRatio: "1 / 1" }}
                    >
                      <ImageOrPlaceholder
                        src={image?.url}
                        alt={image?.alt_text || ing.name}
                        fill
                        sizes="64px"
                        aspect="1/1"
                        className="object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <h3 className="text-base font-semibold text-zinc-900 sm:text-lg">
                          {ing.name}
                        </h3>
                        {ing.dosage_display && (
                          <span className="text-sm text-zinc-500">{ing.dosage_display}</span>
                        )}
                      </div>
                      {topBenefit && (
                        <p className="mt-1 text-sm font-medium text-emerald-700">
                          {topBenefit.benefit_headline}
                        </p>
                      )}
                      {topBenefit?.mechanism_explanation && (
                        <p className="mt-1 line-clamp-2 text-sm text-zinc-600 group-open:hidden">
                          {topBenefit.mechanism_explanation}
                        </p>
                      )}
                    </div>
                  </div>
                  <span
                    className="mt-1 flex-shrink-0 text-zinc-400 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  >
                    <ChevronDown />
                  </span>
                </summary>

                {research.length > 0 && (
                  <div className="mt-4 space-y-4 border-t border-zinc-100 pt-4 text-sm text-zinc-700">
                    {research.map((r) => (
                      <div key={r.id}>
                        <p className="font-semibold text-zinc-900">{r.benefit_headline}</p>
                        <p className="mt-1">{r.mechanism_explanation}</p>
                        {r.dosage_comparison && (
                          <p className="mt-1 text-xs text-zinc-500">
                            <strong>Dosage:</strong> {r.dosage_comparison}
                          </p>
                        )}
                        {Array.isArray(r.citations) && r.citations.length > 0 && (
                          <p className="mt-1 text-xs text-zinc-500">
                            Supported by {r.citations.length} study{r.citations.length === 1 ? "" : "ies"}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </details>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ChevronDown() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
