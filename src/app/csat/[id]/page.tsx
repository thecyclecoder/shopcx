"use client";

import { useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Image from "next/image";

export default function CsatPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const ticketId = params.id as string;
  const token = searchParams.get("token");
  const presetScore = searchParams.get("score");

  const [score, setScore] = useState<number | null>(presetScore ? parseInt(presetScore) : null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (selectedScore: number) => {
    setScore(selectedScore);
    const res = await fetch(`/api/csat/${ticketId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ score: selectedScore, token }),
    });

    if (res.ok) {
      setSubmitted(true);
    } else {
      const data = await res.json();
      setError(data.error || "Failed to submit");
    }
  };

  if (submitted) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 dark:bg-zinc-950">
        <Image src="/logo.svg" alt="ShopCX.AI" width={48} height={48} />
        <h1 className="mt-6 text-xl font-bold text-zinc-900 dark:text-zinc-100">Thank you!</h1>
        <p className="mt-2 text-sm text-zinc-500">Your feedback helps us improve.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 dark:bg-zinc-950">
      <Image src="/logo.svg" alt="ShopCX.AI" width={48} height={48} />
      <h1 className="mt-6 text-xl font-bold text-zinc-900 dark:text-zinc-100">
        How was your experience?
      </h1>
      <p className="mt-2 text-sm text-zinc-500">Rate your support interaction</p>

      <div className="mt-8 flex gap-3">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => handleSubmit(n)}
            className={`flex h-14 w-14 items-center justify-center rounded-xl text-lg font-bold transition-all ${
              score === n
                ? "scale-110 ring-2 ring-indigo-500"
                : ""
            } ${
              n <= 2
                ? "bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400"
                : n === 3
                  ? "bg-amber-100 text-amber-600 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400"
                  : "bg-emerald-100 text-emerald-600 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-zinc-400">1 = Poor, 5 = Excellent</p>
      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
    </div>
  );
}
