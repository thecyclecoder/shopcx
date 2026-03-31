"use client";

import { useState } from "react";

export default function PortalLogin() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/portal/multipass-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = await res.json();

      if (data.redirect_url) {
        window.location.href = data.redirect_url;
      } else {
        setError(data.error || "Could not log in. Please try again.");
        setLoading(false);
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
      <h1 style={{ fontSize: 24, fontWeight: 900, marginBottom: 8 }}>Manage your subscriptions</h1>
      <p style={{ color: "#6b7280", marginBottom: 32, fontSize: 15 }}>
        Enter your email to access your account.
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          style={{
            padding: "14px 16px", borderRadius: 12, border: "1px solid #e5e7eb",
            fontSize: 16, outline: "none", width: "100%", boxSizing: "border-box",
          }}
        />
        <button
          type="submit"
          disabled={loading || !email.trim()}
          style={{
            padding: "14px 24px", borderRadius: 12, border: "none",
            background: "#111827", color: "#fff", fontSize: 16, fontWeight: 700,
            cursor: loading ? "wait" : "pointer", opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? "Connecting..." : "Continue"}
        </button>
      </form>
      {error && <p style={{ color: "#dc2626", marginTop: 16, fontSize: 14 }}>{error}</p>}
    </div>
  );
}
