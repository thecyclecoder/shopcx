/**
 * PUBLIC review page — the tokenized magic link's landing surface. No login.
 *
 * Ascending effort by design: 5-star (one click) → sliders (a few drags) →
 * comment (typing). Each step is a small commitment that makes the next one
 * easier, and the comment prompt is seeded from the customer's own slider
 * answers so they answer a question instead of facing a blank box.
 */
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { use as usePromise } from "react";

type Question = {
  key: string;
  label: string;
  type: string;
  min_label?: string;
  max_label?: string;
  labels?: string[];
};

// cacheComponents is ON (for the storefront's fast cached PDPs). This client page reads
// use(params), which is dynamic — under Cache Components that MUST sit inside a <Suspense>
// boundary or the prerender fails ("encountered uncached or runtime data during prerendering").
// The default export wraps the real page. Same shape as src/app/csat/[ticketId]/page.tsx.
export default function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={null}>
      <ReviewPageInner params={params} />
    </Suspense>
  );
}

function ReviewPageInner({ params }: { params: Promise<{ token: string }> }) {
  const { token } = usePromise(params);
  const [state, setState] = useState<"loading" | "form" | "done" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [product, setProduct] = useState<{ title: string | null; image_url: string | null } | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [minLen, setMinLen] = useState(15);

  const [rating, setRating] = useState(0);
  const [scores, setScores] = useState<Record<string, number | string>>({});
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reward, setReward] = useState<string | null>(null);
  const [published, setPublished] = useState(true);

  useEffect(() => {
    fetch(`/api/review/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) { setError(d.error || "unavailable"); setState("error"); return; }
        setProduct(d.product); setQuestions(d.questions || []);
        setMinLen(d.min_comment_length || 15); setState("form");
      })
      .catch(() => { setError("network"); setState("error"); });
  }, [token]);

  // The comment prompt is built from what they just told us — turning a blank
  // box into a question they've already half-answered.
  const seededPrompt = useCallback(() => {
    const hi = questions.filter((q) => Number(scores[q.key]) >= 4).map((q) => q.label.toLowerCase());
    if (rating >= 4 && hi.length >= 2) {
      return `You rated ${hi[0]} and ${hi[1]} highly — what would you tell someone who's on the fence?`;
    }
    if (rating >= 4) return `What would you tell someone who's on the fence about ${product?.title || "it"}?`;
    return `What didn't work for you? We read every one of these.`;
  }, [questions, scores, rating, product]);

  async function submit() {
    setSubmitting(true);
    const res = await fetch(`/api/review/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating, attribute_scores: scores, comment }),
    });
    const d = await res.json();
    setSubmitting(false);
    if (!res.ok) { setError(d.error || "submit_failed"); setState("error"); return; }
    setReward(d.reward_code || null);
    setPublished(!!d.published);
    setState("done");
  }

  if (state === "loading") return <Shell><p>Loading…</p></Shell>;

  if (state === "error") {
    const msg =
      error === "session_expired" ? "This link has expired."
      : error === "session_already_completed" ? "You've already left this review — thank you!"
      : error === "session_not_found" ? "This link isn't valid."
      : "Something went wrong. Please try again.";
    return <Shell><p>{msg}</p></Shell>;
  }

  if (state === "done") {
    return (
      <Shell>
        <h1 style={{ fontSize: 24, margin: "0 0 10px" }}>Thank you — genuinely.</h1>
        <p style={{ color: "#3a3a3a", lineHeight: 1.55 }}>
          {published
            ? "Your review is live on the site."
            : "We've passed this to our team — someone will follow up with you."}
        </p>
        {reward && (
          <div style={{ marginTop: 22, padding: 18, background: "#f7f6f2", borderRadius: 14 }}>
            <p style={{ margin: "0 0 6px", color: "#6b6b6b", fontSize: 13 }}>Your thank-you code</p>
            <p style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: 1 }}>{reward}</p>
          </div>
        )}
      </Shell>
    );
  }

  const canSubmit = rating > 0 && comment.trim().length >= minLen && !submitting;

  return (
    <Shell>
      {product?.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.image_url} alt={product.title || ""} style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 14, marginBottom: 16 }} />
      )}
      <h1 style={{ fontSize: 24, margin: "0 0 6px" }}>How's the {product?.title}?</h1>
      <p style={{ color: "#6b6b6b", margin: "0 0 22px" }}>Takes about a minute.</p>

      <div style={{ marginBottom: 26 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => setRating(n)} aria-label={`${n} stars`}
            style={{ background: "none", border: "none", fontSize: 34, cursor: "pointer", color: n <= rating ? "#f5a623" : "#d8d8d8", padding: "0 2px" }}>★</button>
        ))}
      </div>

      {rating > 0 && questions.map((q) => (
        <div key={q.key} style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>{q.label}</label>
          <input type="range" min={1} max={5} step={1}
            value={Number(scores[q.key] || 3)}
            onChange={(e) => setScores((s) => ({ ...s, [q.key]: Number(e.target.value) }))}
            style={{ width: "100%" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9a9a9a" }}>
            <span>{q.min_label || q.labels?.[0]}</span>
            <span>{q.max_label || q.labels?.[q.labels.length - 1]}</span>
          </div>
        </div>
      ))}

      {rating > 0 && (
        <div style={{ marginTop: 8 }}>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>{seededPrompt()}</label>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={5}
            style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd", fontFamily: "inherit", fontSize: 15 }} />
          <p style={{ fontSize: 12, color: "#9a9a9a", margin: "6px 0 0" }}>
            {comment.trim().length < minLen ? `${minLen - comment.trim().length} more characters` : " "}
          </p>
        </div>
      )}

      {rating > 0 && (
        <button onClick={submit} disabled={!canSubmit}
          style={{ marginTop: 18, background: canSubmit ? "#006540" : "#c9c9c9", color: "#fff", border: 0, borderRadius: 999, padding: "14px 32px", fontSize: 16, cursor: canSubmit ? "pointer" : "default" }}>
          {submitting ? "Sending…" : "Submit review"}
        </button>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 620, margin: "0 auto", padding: "48px 20px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#121212" }}>
      {children}
    </main>
  );
}
