/**
 * Blog author personas (E-E-A-T bylines) — spec: auto-blog-generation.
 *
 * A small, consistent set of named authors with real bios + photos so posts
 * carry human authorship signals (Person schema, author archive) instead of
 * "admin" or an org byline — one of the strongest "this isn't scaled AI"
 * signals to search engines. The auto-blog writer picks the persona that fits
 * the post's archetype (recipe → Renee, science/explainer → Priya, lifestyle →
 * Marcus) and stamps `posts.author_slug`.
 *
 * Single-tenant for now; multi-tenant moves this to an `authors` table (spec).
 */

export interface BlogAuthor {
  slug: string;
  name: string;
  role: string;
  /** 1-2 sentence bio — rendered under the byline + as the Person description. */
  bio: string;
  avatarUrl: string;
  /** Which post archetypes this author is the natural voice for. */
  archetypes: Array<"recipe" | "science" | "how_it_works" | "how_to_use" | "lifestyle" | "general">;
}

const AVATAR_BASE =
  "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/workspaces/fdc11e10-b89f-4989-8b73-ed6526c4d906/authors";

export const BLOG_AUTHORS: Record<string, BlogAuthor> = {
  "renee-calhoun": {
    slug: "renee-calhoun",
    name: "Renee Calhoun",
    role: "Recipe Developer",
    bio: "Renee develops recipes at Superfoods Company and has been a two-cups-before-noon coffee drinker for twenty years. Every recipe here gets tested in her own kitchen first.",
    avatarUrl: `${AVATAR_BASE}/renee-calhoun.webp`,
    archetypes: ["recipe", "how_to_use", "lifestyle"],
  },
  "priya-anand": {
    slug: "priya-anand",
    name: "Priya Anand, RD",
    role: "Nutrition Lead",
    bio: "Priya is a registered dietitian who reviews the science behind every ingredient we use. She spends her days turning clinical research into plain English.",
    avatarUrl: `${AVATAR_BASE}/priya-anand.webp`,
    archetypes: ["science", "how_it_works", "general"],
  },
  "marcus-hale": {
    slug: "marcus-hale",
    name: "Marcus Hale",
    role: "Wellness Editor",
    bio: "Marcus writes about the small daily habits that actually add up. A reformed energy-drink addict, he's spent the last decade chasing a better morning.",
    avatarUrl: `${AVATAR_BASE}/marcus-hale.webp`,
    archetypes: ["lifestyle", "general", "how_to_use"],
  },
};

export const DEFAULT_AUTHOR_SLUG = "renee-calhoun";

export function getAuthor(slug: string | null | undefined): BlogAuthor | null {
  if (!slug) return null;
  return BLOG_AUTHORS[slug] || null;
}

/** Pick the persona that best fits an archetype (first match, else default). */
export function authorForArchetype(archetype: BlogAuthor["archetypes"][number]): BlogAuthor {
  for (const a of Object.values(BLOG_AUTHORS)) {
    if (a.archetypes.includes(archetype)) return a;
  }
  return BLOG_AUTHORS[DEFAULT_AUTHOR_SLUG];
}
