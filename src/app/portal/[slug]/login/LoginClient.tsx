"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface Props {
  logoUrl: string;
  primaryColor: string;
  brandName: string;
}

export default function LoginClient(props: Props) {
  return (
    <Suspense fallback={<div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}><p style={{ color: "#6b7280" }}>Loading...</p></div>}>
      <PortalLogin {...props} />
    </Suspense>
  );
}

function transformLogoUrl(url: string, heightPx: number): string {
  if (!url.includes("supabase.co/storage/v1/object/public/")) return url;
  const base = url.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}height=${heightPx * 2}&resize=contain`;
}

function PortalLogin({ logoUrl, primaryColor, brandName }: Props) {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [autoLogging, setAutoLogging] = useState(false);

  useEffect(() => {
    if (!token) return;
    setAutoLogging(true);
    fetch("/api/portal/magic-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.success && data.redirectUrl) {
          window.location.href = data.redirectUrl;
        } else {
          setError(data.error || "Invalid or expired link. Please enter your email below.");
          setAutoLogging(false);
        }
      })
      .catch(() => {
        setError("Something went wrong. Please enter your email below.");
        setAutoLogging(false);
      });
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/portal/magic-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setError("");
        setLoading(false);
        setEmailSent(true);
      } else {
        setError(data.error || "Could not send login link. Please try again.");
        setLoading(false);
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  const logoEl = logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={transformLogoUrl(logoUrl, 96)}
      alt={brandName || "Logo"}
      style={{ display: "block", margin: "0 auto 32px", height: 56, width: "auto" }}
    />
  ) : brandName ? (
    <div style={{ textAlign: "center", marginBottom: 32, fontSize: 22, fontWeight: 800, color: primaryColor }}>
      {brandName}
    </div>
  ) : null;

  if (autoLogging) {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
        {logoEl}
        <div style={{ marginBottom: 16 }}>
          <div style={{
            width: 32, height: 32, margin: "0 auto", border: "3px solid #e5e7eb",
            borderTopColor: primaryColor, borderRadius: "50%",
            animation: "spin 0.8s linear infinite",
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
        <p style={{ color: "#6b7280", fontSize: 15 }}>Signing you in...</p>
      </div>
    );
  }

  if (emailSent) {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
        {logoEl}
        <div style={{ fontSize: 48, marginBottom: 16 }}>📧</div>
        <h1 style={{ fontSize: 24, fontWeight: 900, marginBottom: 8 }}>Check your email</h1>
        <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 15 }}>
          We sent a login link to your email. Click the link to access your account.
        </p>
        <button
          onClick={() => { setEmailSent(false); setEmail(""); }}
          style={{ color: primaryColor, fontSize: 14, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
        >
          Try a different email
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center", padding: "0 20px" }}>
      {logoEl}
      <h1 style={{ fontSize: 28, fontWeight: 900, marginBottom: 8, color: "#18181b" }}>My Account</h1>
      <p style={{ color: "#6b7280", marginBottom: 32, fontSize: 15 }}>
        Enter your email and we&apos;ll send you a login link.
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
            background: primaryColor, color: "#fff", fontSize: 16, fontWeight: 700,
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
