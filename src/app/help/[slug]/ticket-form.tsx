"use client";

import { useState } from "react";

const CATEGORY_LABELS: Record<string, string> = {
  product: "Product question",
  policy: "Policy inquiry",
  shipping: "Shipping & delivery",
  billing: "Billing & payment",
  subscription: "Subscription",
  general: "General question",
  faq: "FAQ",
  troubleshooting: "Technical issue",
};

export default function TicketForm({ slug, categories }: { slug: string; categories: string[] }) {
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !message) return;
    setSending(true);
    setResult(null);

    try {
      const res = await fetch(`/api/help/${slug}/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, subject, message, category: category || null }),
      });

      const data = await res.json();
      if (res.ok) {
        setResult({ success: true, message: data.message || "Submitted!" });
        setEmail("");
        setSubject("");
        setMessage("");
        setCategory("");
      } else {
        setResult({ success: false, message: data.error || "Something went wrong" });
      }
    } catch {
      setResult({ success: false, message: "Failed to submit" });
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-zinc-700">Your email *</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-700">What is this about?</label>
        <div className="mt-2 flex flex-wrap gap-2">
          {categories.map(cat => (
            <label key={cat} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${
              category === cat
                ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                : "border-zinc-200 text-zinc-600 hover:border-zinc-300"
            }`}>
              <input
                type="radio"
                name="category"
                value={cat}
                checked={category === cat}
                onChange={() => setCategory(cat)}
                className="sr-only"
              />
              {CATEGORY_LABELS[cat] || cat}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-700">Subject</label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Brief description"
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-700">Message *</label>
        <textarea
          required
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="How can we help?"
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      <button
        type="submit"
        disabled={sending || !email || !message}
        className="w-full rounded-md bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {sending ? "Sending..." : "Submit Request"}
      </button>

      {result && (
        <div className={`rounded-md p-3 text-sm ${
          result.success
            ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border border-red-200 bg-red-50 text-red-700"
        }`}>
          {result.message}
        </div>
      )}
    </form>
  );
}
