import type { BlogPostCard as Card } from "../_lib/blog-data";
import { groupingLabel } from "../_lib/blog-data";

/** Article card used on the blog index + the related-posts strip. Server
 *  component — no interactivity beyond the wrapping link. */
export function BlogPostCard({ post }: { post: Card }) {
  const label = groupingLabel(post.grouping);
  return (
    <a
      href={`/blog/${post.handle}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md"
    >
      {post.featured_image_url && (
        <div className="aspect-[16/10] w-full overflow-hidden bg-zinc-100">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={post.featured_image_url}
            alt={post.title}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        </div>
      )}
      <div className="flex flex-1 flex-col p-5">
        {label && (
          <span
            className="mb-2 inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide"
            style={{
              color: "var(--storefront-accent)",
              backgroundColor: "color-mix(in srgb, var(--storefront-accent) 12%, white)",
            }}
          >
            {label}
          </span>
        )}
        <h3 className="text-lg font-semibold leading-snug text-zinc-900 group-hover:text-zinc-700">
          {post.title}
        </h3>
        {post.excerpt && (
          <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-zinc-500">
            {post.excerpt}
          </p>
        )}
        <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-zinc-900">
          Read more
          <svg className="h-4 w-4 transition group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </span>
      </div>
    </a>
  );
}
