"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function HelpSearch({ slug }: { slug: string }) {
  const [query, setQuery] = useState("");
  const router = useRouter();

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (query.trim()) router.push(`/help/${slug}?search=${encodeURIComponent(query)}`); }}>
      <div className="relative">
        <svg className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for help..."
          className="w-full rounded-lg border border-zinc-300 bg-white py-3 pl-10 pr-4 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        />
      </div>
    </form>
  );
}
