import type { SupplementFacts } from "../_lib/page-data";

/**
 * CSS-rendered Supplement Facts panel — mirrors the FDA-mandated
 * label layout (thick top border, two header rules, three-column body
 * with name / amount / % daily value, indented sub-nutrients,
 * proprietary blend with ingredients list, footer asterisks, "Other
 * Ingredients" footer).
 *
 * Done with native CSS so it's easily edited (no image swap when the
 * ingredient list changes) and scales cleanly across viewports.
 * Black on white, Helvetica-like stack to match the regulated look.
 */
export function SupplementFactsPanel({ facts }: { facts: SupplementFacts }) {
  return (
    <div
      className="mx-auto w-full max-w-md border-2 border-black bg-white p-4 font-sans text-black"
      style={{ fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif' }}
    >
      <h3 className="text-3xl font-extrabold leading-none tracking-tight">
        Supplement Facts
      </h3>

      <dl className="mt-2 flex items-baseline justify-between border-b border-black pb-1.5 text-sm leading-tight">
        <dt>Serving Size:</dt>
        <dd className="font-semibold">{facts.serving_size}</dd>
      </dl>
      <dl className="flex items-baseline justify-between border-b-[6px] border-black pb-1.5 pt-1 text-sm leading-tight">
        <dt>Servings Per Container:</dt>
        <dd className="font-semibold">{facts.servings_per_container}</dd>
      </dl>

      {/* Column headers */}
      <div className="flex items-baseline justify-end gap-4 border-b border-black py-1 text-[11px] font-semibold leading-tight">
        <span>Amount Per Serving</span>
        <span>% Daily Value</span>
      </div>

      {/* Nutrient rows */}
      <ul>
        {facts.nutrients.map((n, i) => (
          <li
            key={i}
            className={`flex items-baseline gap-2 border-b border-black/40 py-1.5 text-sm leading-tight ${
              n.indent > 0 ? "pl-4" : ""
            }`}
          >
            <span className={n.indent === 0 ? "font-semibold" : ""}>
              {n.name}
            </span>
            <span className="flex-1" />
            <span className="font-semibold tabular-nums">{n.amount}</span>
            <span className="ml-3 w-12 text-right font-semibold tabular-nums">
              {n.daily_value || ""}
            </span>
          </li>
        ))}
      </ul>

      {/* Proprietary blend — heavier top border to call it out */}
      {facts.proprietary_blend && (
        <div className="border-t-[6px] border-black pt-2">
          <div className="flex items-baseline gap-2 text-sm leading-tight">
            <span className="font-bold">Proprietary Blend:</span>
            <span className="flex-1" />
            <span className="font-bold tabular-nums">
              {facts.proprietary_blend.amount}
            </span>
            <span className="ml-3 w-12 text-right font-semibold tabular-nums">
              {facts.proprietary_blend.daily_value}
            </span>
          </div>
          <p className="mt-1.5 text-[13px] leading-snug">
            {facts.proprietary_blend.ingredients}
          </p>
        </div>
      )}

      {/* Footer notes — small italic disclaimers */}
      {facts.footer_notes.length > 0 && (
        <ul className="mt-3 space-y-0.5 border-t border-black pt-2 text-[11px] leading-snug">
          {facts.footer_notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}

      {/* Other ingredients lives outside the regulated facts block but
          ships in the same component because it's part of the panel
          customers expect to see. */}
      {facts.other_ingredients && (
        <p className="mt-3 border-t border-black pt-2 text-[12px] leading-snug">
          <strong>Other Ingredients:</strong> {facts.other_ingredients}
        </p>
      )}
    </div>
  );
}
