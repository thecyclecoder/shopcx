"use client";

import { useEffect, useMemo, useState } from "react";
import type { BlogPostCard as Card } from "../_lib/blog-data";
import { BlogPostCard } from "./BlogPostCard";

/**
 * Client-side topic filter over the full, server-rendered post list. Every
 * post is already in the initial HTML (SEO + LLM ingestion); this only
 * toggles which cards are visible based on the `?topic=` param the header
 * tabs set. Reads the param from the URL (no useSearchParams, so the page
 * stays statically generated) — header tabs are full-navigation links, so
 * the param is read fresh on each load.
 */
export function BlogIndexGrid({
  posts,
  topics,
}: {
  posts: Card[];
  topics: { key: string; label: string }[];
}) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const topic = new URLSearchParams(window.location.search).get("topic");
    setActive(topic && topics.some((t) => t.key === topic) ? topic : null);
  }, [topics]);

  const filtered = useMemo(
    () => (active ? posts.filter((p) => p.grouping === active) : posts),
    [posts, active],
  );

  if (filtered.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-12 text-center text-sm text-zinc-500">
        No articles here yet.
      </div>
    );
  }

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {filtered.map((p) => (
        <BlogPostCard key={p.id} post={p} />
      ))}
    </div>
  );
}
