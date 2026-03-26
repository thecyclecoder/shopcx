"use client";

import { useState } from "react";

export default function ArticleFeedback({ articleId, slug }: { articleId: string; slug: string }) {
  const [voted, setVoted] = useState<"up" | "down" | null>(null);

  const handleVote = async (vote: "up" | "down") => {
    setVoted(vote);
    try {
      await fetch(`/api/help/${slug}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ article_id: articleId, vote }),
      });
    } catch {}
  };

  if (voted) {
    return (
      <div className="mt-8 rounded-lg border border-zinc-200 bg-white p-6 text-center">
        <p className="text-sm text-zinc-600">
          {voted === "up" ? "Glad this helped!" : "Thanks for letting us know. We\u2019ll work on improving this article."}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-8 rounded-lg border border-zinc-200 bg-white p-6 text-center">
      <p className="text-sm text-zinc-600">Was this article helpful?</p>
      <div className="mt-3 flex items-center justify-center gap-3">
        <button
          onClick={() => handleVote("up")}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.633 10.25c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 0 1 2.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 0 0 .322-1.672V2.75a.75.75 0 0 1 .75-.75 2.25 2.25 0 0 1 2.25 2.25c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282m0 0h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 0 1-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 0 0-1.423-.23H5.904m10.598-9.75H14.25M5.904 18.5c.083.205.173.405.27.602.197.4-.078.898-.523.898h-.908c-.889 0-1.713-.518-1.972-1.368a12 12 0 0 1-.521-3.507c0-1.553.295-3.036.831-4.398C3.387 9.953 4.167 9.5 5 9.5h1.053c.472 0 .745.556.5.96a8.958 8.958 0 0 0-1.302 4.665c0 1.194.232 2.333.654 3.375Z" />
          </svg>
          Yes
        </button>
        <button
          onClick={() => handleVote("down")}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.498 15.25H4.372c-1.026 0-1.945-.694-2.054-1.715a12.137 12.137 0 0 1-.068-1.285c0-2.848.992-5.464 2.649-7.521C5.287 4.247 5.886 4 6.504 4h4.016a4.5 4.5 0 0 1 1.423.23l3.114 1.04a4.5 4.5 0 0 0 1.423.23h1.294M7.498 15.25c.618 0 .991.724.725 1.282A7.471 7.471 0 0 0 7.5 19.75 2.25 2.25 0 0 0 9.75 22a.75.75 0 0 0 .75-.75v-.633c0-.573.11-1.14.322-1.672.304-.76.93-1.33 1.653-1.715a9.04 9.04 0 0 0 2.86-2.4c.498-.634 1.226-1.08 2.032-1.08h.384m-10.253 1.5H9.7m8.075-9.75c.01.05.027.1.05.148.593 1.2.925 2.55.925 3.977 0 1.31-.269 2.559-.754 3.695-.064.153-.105.317-.105.487v.556c0 .5.25.978.66 1.262l.96.67a.5.5 0 0 0 .783-.414v-.396a4.002 4.002 0 0 0-.654-2.193" />
          </svg>
          No
        </button>
      </div>
    </div>
  );
}
