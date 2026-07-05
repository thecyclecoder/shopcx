import type { PageData } from "../_lib/page-data";
import type { BlueprintRenderContent, BlueprintRenderBlock } from "@/lib/blueprint-render";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * Blueprint-driven storefront lander — renders a [[lander_blueprints]] row's
 * content block-by-block. Every block's copy is authored by Carrie in
 * lander_blueprints.content.blocks[i].copy; image slots are resolved to
 * product_media in [[../lib/blueprint-render]] `loadBlueprintRenderContent`.
 *
 * Layout is generic across blueprints (any funnel_type Cleo authored): copy
 * is rendered in a serif editorial column, images inline where a block
 * resolved one, inline CTAs on the offer / reason / final blocks. The
 * blueprint's block ORDER is the source of truth — the render is a pure
 * iteration, no hardcoded chapter list.
 */

const SERIF = "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif";

function lowestPriceCents(data: PageData): number | null {
  return data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;
}

/** Split a block's `copy` string into paragraph runs — the copy is authored as
 *  free text with blank-line breaks; we render each run as its own <p>. The
 *  first non-empty line of the hero and reasons blocks reads as a heading. */
function paragraphsOf(copy: string): string[] {
  return copy
    .split(/\n{2,}/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** True when a block role should carry an inline CTA (offer / recap / mid-list). */
function blockHasInlineCta(role: string): boolean {
  const r = role.toLowerCase();
  return (
    r.includes("offer") ||
    r.includes("reasons_1") ||
    r.includes("reasons_2_5") ||
    r.includes("reasons_6") ||
    r.includes("recap") ||
    r === "hero"
  );
}

function BlockImage({ block }: { block: BlueprintRenderBlock }) {
  if (!block.imageUrl) return null;
  return (
    <div className="my-6 overflow-hidden rounded-xl">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={block.imageUrl}
        alt={block.imageAlt || block.role}
        className="h-auto w-full"
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

function BlockCopy({ block }: { block: BlueprintRenderBlock }) {
  const paras = paragraphsOf(block.copy);
  if (paras.length === 0) return null;
  const [lead, ...rest] = paras;
  const isHeadingLead = /^#\d+\s|^\d+\.\s|^\d+ reasons/i.test(lead) || block.role.toLowerCase() === "hero";
  return (
    <div>
      {isHeadingLead ? (
        <h2
          style={{ fontFamily: SERIF }}
          className="mb-4 text-2xl font-black leading-snug tracking-tight text-zinc-900 sm:text-3xl"
        >
          {lead}
        </h2>
      ) : (
        <p className="mb-4 text-lg leading-relaxed text-zinc-800">{lead}</p>
      )}
      {rest.map((p, i) => (
        <p key={i} className="mb-4 text-lg leading-relaxed text-zinc-800">
          {p}
        </p>
      ))}
    </div>
  );
}

export function BlueprintLander({
  data,
  content,
}: {
  data: PageData;
  content: BlueprintRenderContent;
}) {
  const price = lowestPriceCents(data);
  return (
    <section data-section="blueprint-lander" className="w-full bg-[#FBF8F2]">
      <div className="mx-auto max-w-2xl px-5 py-10 md:px-8 md:py-14">
        {content.blocks.map((block, i) => (
          <div
            key={`${block.role}-${i}`}
            data-section={`blueprint-block-${block.role}`}
            className={i === 0 ? "" : "mt-10 border-t border-zinc-200 pt-10"}
          >
            <BlockImage block={block} />
            <BlockCopy block={block} />
            {blockHasInlineCta(block.role) && (
              <div className="mt-6">
                <ShopCTA lowestPriceCents={price} align="center" />
              </div>
            )}
          </div>
        ))}
        {content.cta && (
          <div className="mt-12 rounded-2xl bg-white p-7 text-center shadow-sm sm:p-9">
            <p
              style={{ fontFamily: SERIF }}
              className="text-xl font-black leading-snug text-zinc-900 sm:text-2xl"
            >
              {content.cta}
            </p>
            <div className="mt-6">
              <ShopCTA lowestPriceCents={price} align="center" />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
