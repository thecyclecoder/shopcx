# `src/lib/blog/authors.ts` — blog author personas (E-E-A-T byline registry)

The named-human-author layer for auto-generated posts ([[../lifecycles/auto-blog-generation]]). Three invented personas live in a **code registry** (not a table — simplest for single-tenant); the writer picks one by archetype and `posts.author_slug` stamps it. Rendered as a byline (photo + name + role + date) + an author-bio card + JSON-LD **Person** (the E-E-A-T signal — never attribute to "admin" or the org alone).

## Exports

| Export | Shape | Notes |
|---|---|---|
| `BLOG_AUTHORS` | `Record<slug, BlogAuthor>` | The 3 personas. Each: name, role, bio, avatar path (`workspaces/{ws}/authors/{slug}.webp`), `archetypes[]`. |
| `DEFAULT_AUTHOR_SLUG` | `"renee-calhoun"` | Fallback. |
| `getAuthor(slug)` | `→ BlogAuthor \| null` | Resolve a stamped `posts.author_slug`. |
| `authorForArchetype(archetype)` | `→ BlogAuthor` | Pick the persona whose `archetypes` covers the topic. |

## The personas
- **Renee Calhoun** — Recipe Developer (recipe posts).
- **Priya Anand, RD** — Nutrition Lead (science / explainers).
- **Marcus Hale** — Wellness Editor (lifestyle).

## Gotchas
- **Registry, not an `authors` table** — promote to a table + `/blog/author/{slug}` archive pages when multi-tenant or when author archive pages are wanted (bigger E-E-A-T boost). Today the byline + JSON-LD Person are enough.
- **`author_slug` is the only DB coupling** — added in migration `20260610200000_blog_author_social.sql` (alongside `social_image_url`). A null/unknown slug falls back to `DEFAULT_AUTHOR_SLUG`.

## Callers
- [[blog__select-topic]] (`authorForArchetype` at selection) · [[../inngest/auto-blog]] (stamps `author_slug`) · the storefront blog render (byline + JSON-LD).

## Related
[[../lifecycles/auto-blog-generation]] · [[blog__select-topic]] · [[blog__write-post]] · [[../tables/posts]] · [[../lifecycles/blog-resources]]
