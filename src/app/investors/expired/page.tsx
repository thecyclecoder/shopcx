"use client";

import { useState } from "react";

// Shown when a magic link is missing/expired/invalid, or a session lapses. Lets
// an investor request a fresh link by email. We never confirm whether an address
// is on the list — the response is always the same reassuring message.
export default function InvestorsExpiredPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || state === "sending") return;
    setState("sending");
    try {
      await fetch("/api/investors/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      /* swallow — we show the same message regardless */
    }
    setState("sent");
  }

  return (
    <div className="inv-gate">
      {state === "sent" ? (
        <>
          <h1>Check your inbox</h1>
          <p>
            If that email is on the investor list, a fresh secure link is on its way. It opens the
            update directly — no password to remember.
          </p>
          <p className="inv-note">Didn&apos;t get it? Give it a minute, then check spam.</p>
        </>
      ) : (
        <>
          <h1>Your secure link expired</h1>
          <p>Enter your email and we&apos;ll send you a fresh one-tap link to this month&apos;s update.</p>
          <form onSubmit={submit}>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button type="submit" disabled={state === "sending"}>
              {state === "sending" ? "Sending…" : "Send link"}
            </button>
          </form>
          <p className="inv-note">Links are personal — please don&apos;t forward yours.</p>
        </>
      )}
    </div>
  );
}
