"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

export default function PatternReviewBanner() {
  const workspace = useWorkspace();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!["owner", "admin"].includes(workspace.role)) return;
    fetch(`/api/workspaces/${workspace.id}/pattern-feedback`)
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d)) {
          setCount(d.filter((f: { status: string }) => f.status === "pending").length);
        }
      })
      .catch(() => {});
  }, [workspace.id, workspace.role]);

  if (count === 0) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900 dark:bg-amber-950">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
            <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
          </svg>
          <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
            {count} pattern suggestion{count !== 1 ? "s" : ""} to review
          </span>
        </div>
        <Link
          href="/dashboard/settings/patterns"
          className="text-xs font-medium text-amber-600 hover:underline dark:text-amber-400"
        >
          Review
        </Link>
      </div>
    </div>
  );
}
