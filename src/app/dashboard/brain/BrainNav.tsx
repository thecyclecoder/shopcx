"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type F = { slug: string; title: string; folder: string };

const ORDER: Record<string, number> = {
  "(root)": 0, lifecycles: 1, dashboard: 2, tables: 3, libraries: 4,
  inngest: 5, integrations: 6, recipes: 7, specs: 8, journeys: 9, playbooks: 10,
};

export default function BrainNav({ folders }: { folders: Record<string, F[]> }) {
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const names = Object.keys(folders).sort((a, b) => (ORDER[a] ?? 20) - (ORDER[b] ?? 20) || a.localeCompare(b));

  return (
    <nav className="hidden w-60 flex-shrink-0 md:block">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter pages…"
        className="mb-3 w-full rounded-md border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
      />
      <div className="max-h-[calc(100vh-9rem)] space-y-3 overflow-y-auto pr-2 text-xs">
        {names.map((name) => {
          const files = folders[name].filter((f) => !ql || f.title.toLowerCase().includes(ql) || f.slug.toLowerCase().includes(ql));
          if (!files.length) return null;
          return (
            <div key={name}>
              <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-400">{name}</div>
              <ul className="space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                {files.map((f) => {
                  const href = `/dashboard/brain/${f.slug}`;
                  const active = pathname === href;
                  return (
                    <li key={f.slug}>
                      <Link
                        href={href}
                        className={active ? "font-medium text-indigo-600 dark:text-indigo-400" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"}
                      >
                        {f.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
