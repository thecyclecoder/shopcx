/**
 * Customer-facing CSAT mini-site.
 *
 * Flow:
 *   1. Gate — "Was your issue resolved?" Yes / No
 *   2a. No  → textarea "tell us what's still wrong" → reopen ticket
 *   2b. Yes → 5-star rating + optional comment → award 500 points
 *
 * Pre-rating: ?score=N in the URL jumps straight to step 2b with the
 * star pre-selected (still requires explicit confirm + submit).
 */
"use client";

import { useEffect, useState, use } from "react";
import { useSearchParams } from "next/navigation";

type Step = "loading" | "gate" | "reopen" | "rate" | "comment" | "thanks-rated" | "thanks-reopened" | "already-submitted";

export default function CsatPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = use(params);
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const preScore = parseInt(searchParams.get("score") || "0", 10);

  const [step, setStep] = useState<Step>("loading");
  const [rating, setRating] = useState<number>(preScore >= 1 && preScore <= 5 ? preScore : 0);
  const [comment, setComment] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pointsAwarded, setPointsAwarded] = useState(0);
  const [existingRating, setExistingRating] = useState<number>(0);
  const [existingComment, setExistingComment] = useState<string | null>(null);
  const [existingSubmittedAt, setExistingSubmittedAt] = useState<string | null>(null);
  const [existingPoints, setExistingPoints] = useState(0);

  // On load: check if this ticket already has a CSAT submitted. If
  // yes, jump straight to the already-submitted view (handles
  // refresh-after-submit on mobile and second-click from the email).
  useEffect(() => {
    if (!token) { setStep("gate"); return; }
    fetch(`/api/csat/${ticketId}?token=${encodeURIComponent(token)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.existing) {
          setExistingRating(data.existing.rating);
          setExistingComment(data.existing.comment || null);
          setExistingSubmittedAt(data.existing.submitted_at || null);
          setExistingPoints(data.existing.points_awarded || 0);
          setStep("already-submitted");
        } else if (preScore >= 1 && preScore <= 5) {
          // Deep-link from email with pre-selected rating → jump to
          // the comment step rather than re-showing the gate.
          setStep("comment");
        } else {
          setStep("gate");
        }
      })
      .catch(() => setStep("gate"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId, token]);

  async function submitReopen() {
    if (!reopenReason.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/csat/${ticketId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "reopen", reason: reopenReason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Submit failed"); return; }
      setStep("thanks-reopened");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitRating() {
    if (rating < 1 || rating > 5) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/csat/${ticketId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "rate", rating, comment: comment.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Submit failed"); return; }
      setPointsAwarded(data.points_awarded || 0);
      setStep("thanks-rated");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-white px-4 py-12 dark:from-zinc-950 dark:to-zinc-900">
      <div className="mx-auto max-w-md rounded-2xl bg-white p-8 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
        {step === "loading" && (
          <div className="py-10 text-center text-sm text-zinc-500">Loading…</div>
        )}

        {step === "already-submitted" && (
          <div className="text-center">
            <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full text-2xl font-bold ${
              existingRating >= 4 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" :
              existingRating === 3 ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400" :
              "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
            }`}>{existingRating}</div>
            <h1 className="mt-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Thanks — we got your rating</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-300">
              You rated this <strong>{existingRating} / 5</strong>
              {existingSubmittedAt && <> on <time>{new Date(existingSubmittedAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</time></>}.
            </p>
            {existingComment && (
              <div className="mt-4 rounded-lg bg-zinc-50 p-4 text-left text-[14px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                &ldquo;{existingComment}&rdquo;
              </div>
            )}
            {existingPoints > 0 && (
              <p className="mt-4 text-[13px] text-emerald-600 dark:text-emerald-400">
                +{existingPoints} loyalty points added to your account
              </p>
            )}
          </div>
        )}

        {step === "gate" && (
          <>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Quick question</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-300">
              Did we fully resolve your issue?
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setStep("rate")}
                className="rounded-xl border-2 border-emerald-200 bg-emerald-50 px-4 py-4 text-base font-medium text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400"
              >
                Yes, all good
              </button>
              <button
                type="button"
                onClick={() => setStep("reopen")}
                className="rounded-xl border-2 border-zinc-200 bg-white px-4 py-4 text-base font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              >
                Not yet
              </button>
            </div>
          </>
        )}

        {step === "reopen" && (
          <>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Tell us what&apos;s still wrong</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-300">
              We&apos;ll re-open your ticket and someone from our team will follow up.
            </p>
            <textarea
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="What didn't get resolved?"
              rows={5}
              maxLength={4000}
              className="mt-4 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-[15px] text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <button
              type="button"
              disabled={submitting || !reopenReason.trim()}
              onClick={submitReopen}
              className="mt-4 w-full rounded-xl bg-zinc-900 px-4 py-3 text-base font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {submitting ? "Sending…" : "Reopen my ticket"}
            </button>
            <button
              type="button"
              onClick={() => setStep("gate")}
              disabled={submitting}
              className="mt-2 w-full text-center text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              ← Back
            </button>
          </>
        )}

        {step === "rate" && (
          <>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">How was your experience?</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-300">
              Pick a rating to continue.
            </p>
            <div className="mt-6 flex justify-between gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => { setRating(n); setStep("comment"); }}
                  className={`flex-1 rounded-xl border-2 px-3 py-4 text-2xl font-semibold transition ${
                    rating === n
                      ? n <= 2
                        ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
                        : n <= 3
                          ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400"
                          : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400"
                      : "border-zinc-200 bg-white text-zinc-400 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-500"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="mt-2 text-center text-[11px] text-zinc-400">1 = Poor &nbsp;·&nbsp; 5 = Excellent</p>
            <button
              type="button"
              onClick={() => setStep("gate")}
              disabled={submitting}
              className="mt-6 w-full text-center text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              ← Back
            </button>
          </>
        )}

        {step === "comment" && (
          <>
            <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full text-2xl font-bold ${
              rating >= 4 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" :
              rating === 3 ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400" :
              "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
            }`}>{rating}</div>
            <h1 className="mt-4 text-center text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {rating >= 4 ? "Thanks for the kind rating!" : rating === 3 ? "Got it — thanks for the rating" : "Sorry we missed the mark"}
            </h1>
            <p className="mt-2 text-center text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-300">
              {rating >= 4
                ? "Anything specific you want to call out? Your team loves reading the kind words."
                : rating === 3
                  ? "What would have made this a 5? Even one sentence helps us improve."
                  : "What could we have done differently? Tell us — we read every response."}
            </p>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={rating >= 4 ? "Optional — leave blank to skip" : "Tell us what happened"}
              rows={5}
              maxLength={2000}
              autoFocus
              className="mt-5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-3 text-[15px] text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <button
              type="button"
              disabled={submitting || rating < 1}
              onClick={submitRating}
              className="mt-4 w-full rounded-xl bg-emerald-600 px-4 py-3 text-base font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {submitting ? "Submitting…" : comment.trim() ? "Submit feedback" : "Submit without comment"}
            </button>
            <button
              type="button"
              onClick={() => setStep("rate")}
              disabled={submitting}
              className="mt-2 w-full text-center text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              ← Change rating
            </button>
          </>
        )}

        {step === "thanks-rated" && (
          <div className="text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-3xl dark:bg-emerald-950">
              {rating >= 4 ? "🙏" : rating >= 3 ? "👍" : "💙"}
            </div>
            <h1 className="mt-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Thanks for the feedback</h1>
            {pointsAwarded > 0 ? (
              <p className="mt-2 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                We&apos;ve added <strong>{pointsAwarded} loyalty points</strong> to your account.
              </p>
            ) : (
              <p className="mt-2 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                We appreciate you taking the time.
              </p>
            )}
          </div>
        )}

        {step === "thanks-reopened" && (
          <div className="text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-zinc-100 text-3xl dark:bg-zinc-800">
              💬
            </div>
            <h1 className="mt-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Got it — we&apos;ll be in touch</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-300">
              Your ticket has been reopened. Someone from our team will follow up shortly.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
