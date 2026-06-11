import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getBlogWorkspaceBySlug } from "../../../_lib/blog-data";
import { listLinkInBioEntries, type LinkEntry, type LinkProduct } from "../../../_lib/link-in-bio";
import { storefrontFont } from "../../../_lib/fonts";
import { storefrontThemeStyle } from "../../../_lib/storefront-theme";

/**
 * "Link in bio" page — /links.
 *
 * An Instagram-style feed that mirrors what we recently posted to social — each
 * entry shows the exact post image plus the full content below (a review's full
 * text, a blog post, a shop CTA, or a promo). Set the IG/FB bio link to
 * {domain}/links ONCE; this page stays current automatically (the poster
 * records every post + its image, this reads it). Mobile-first.
 */
export const revalidate = 300;
export const dynamicParams = true;

const MAIN_SITE = "https://superfoodscompany.com";

export async function generateMetadata({ params }: { params: Promise<{ workspace: string }> }): Promise<Metadata> {
  const { workspace } = await params;
  const ws = await getBlogWorkspaceBySlug(workspace);
  if (!ws) return { title: "Not Found" };
  const favicon = ws.design.favicon_url || ws.design.logo_url || null;
  return {
    title: `${ws.name} — Links`,
    description: `The latest from ${ws.name}.`,
    icons: favicon ? { icon: favicon, apple: favicon } : undefined,
    robots: { index: false, follow: true },
  };
}

export default async function LinksPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  const ws = await getBlogWorkspaceBySlug(workspace);
  if (!ws) notFound();

  const entries = await listLinkInBioEntries(ws.id);
  const font = storefrontFont(ws.design.font_key);
  const themeStyle = storefrontThemeStyle(ws.design, font.stack);

  return (
    <div
      className={`${font.className} min-h-screen`}
      style={{ ...themeStyle, background: "linear-gradient(180deg, color-mix(in srgb, var(--storefront-accent) 8%, white) 0%, white 30%)" }}
    >
      <main className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-8">
        <a href={MAIN_SITE} className="flex flex-col items-center">
          {ws.design.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={ws.design.logo_url} alt={ws.name} className="h-12 w-auto" fetchPriority="high" />
          ) : (
            <span className="text-xl font-extrabold text-zinc-900" style={{ fontFamily: "var(--storefront-heading-font)" }}>{ws.name}</span>
          )}
        </a>
        <p className="mt-2 text-center text-sm text-zinc-500">Tap any post for the full story.</p>

        <div className="mt-6 flex w-full flex-col gap-6">
          {entries.map((e) => (
            <FeedCard key={e.key} entry={e} />
          ))}
        </div>

        <a href="/blog" className="mt-8 text-sm font-semibold text-zinc-500 underline-offset-2 hover:underline">See all articles →</a>
      </main>
    </div>
  );
}

function ShopButton({ product }: { product: LinkProduct }) {
  return (
    <a
      href={`/${product.handle}`}
      className="mt-4 flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm transition active:scale-[0.99]"
      style={{ backgroundColor: "var(--storefront-accent)" }}
    >
      <span>Shop {product.title}</span>
      <svg className="h-4 w-4 opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
    </a>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <div className="text-base leading-none" style={{ color: "#F5A300" }}>
      {"★".repeat(Math.max(0, Math.min(5, n)))}<span className="text-zinc-300">{"★".repeat(5 - Math.max(0, Math.min(5, n)))}</span>
    </div>
  );
}

function FeedCard({ entry }: { entry: LinkEntry }) {
  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      {entry.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.image} alt="" loading="lazy" className="w-full" />
      )}
      <div className="p-5">
        {entry.kind === "review" && (
          <>
            {/* The card image already shows the stars + summarized headline; here
                we give the FULL review the card had to truncate. */}
            <Stars n={entry.rating} />
            {entry.body && <p className="mt-2 whitespace-pre-line text-[15px] leading-relaxed text-zinc-700">{entry.body}</p>}
            <p className="mt-3 text-sm font-semibold text-zinc-900">
              {entry.reviewerName} <span className="font-medium text-emerald-700">· ✓ Verified</span>
            </p>
            {entry.product && <ShopButton product={entry.product} />}
          </>
        )}
        {entry.kind === "post" && (
          <>
            <a href={`/blog/${entry.handle}`} className="text-base font-bold leading-snug text-zinc-900 hover:text-zinc-700">{entry.title}</a>
            <div className="mt-1">
              <a href={`/blog/${entry.handle}`} className="text-sm font-semibold text-emerald-700 underline-offset-2 hover:underline">Read the article →</a>
            </div>
            {entry.product && <ShopButton product={entry.product} />}
          </>
        )}
        {entry.kind === "offer" && (
          <>
            <p className="text-base font-bold text-zinc-900">{entry.title}</p>
            {entry.brief && <p className="mt-1 text-sm leading-relaxed text-zinc-600">{entry.brief}</p>}
            {entry.product && <ShopButton product={entry.product} />}
          </>
        )}
        {entry.kind === "shop" && <ShopButton product={entry.product} />}
      </div>
    </article>
  );
}
