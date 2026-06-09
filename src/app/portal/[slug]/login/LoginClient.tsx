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

type Stage = "email" | "code" | "magic_sent" | "auto_logging";

function PortalLogin({ logoUrl, primaryColor, brandName }: Props) {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const next = searchParams.get("next");
  const [stage, setStage] = useState<Stage>(token ? "auto_logging" : "email");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // OTP state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [maskedDestination, setMaskedDestination] = useState("");
  const [hasSms, setHasSms] = useState(false);
  const [code, setCode] = useState("");
  const [resendCountdown, setResendCountdown] = useState(0);

  // Magic-link auto-login when arriving with ?token=
  useEffect(() => {
    if (!token) return;
    fetch("/api/portal/magic-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, next }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.success && data.redirectUrl) {
          window.location.href = data.redirectUrl;
        } else {
          setError(data.error || "Invalid or expired link. Please log in below.");
          setStage("email");
        }
      })
      .catch(() => {
        setError("Something went wrong. Please log in below.");
        setStage("email");
      });
  }, [token, next]);

  // Resend countdown tick
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const t = setTimeout(() => setResendCountdown((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [resendCountdown]);

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError("");
    try {
      // Try OTP first
      const res = await fetch("/api/portal/otp/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (data.eligible && data.session_id) {
        setSessionId(data.session_id);
        setChannel(data.channel);
        setMaskedDestination(data.masked_destination);
        setHasSms(!!data.has_sms);
        setResendCountdown(60);
        setStage("code");
        setLoading(false);
        return;
      }
      // Not eligible OR OTP-not-configured → fall back to magic link
      const magicRes = await fetch("/api/portal/magic-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const magicData = await magicRes.json();
      if (magicData.success) {
        setStage("magic_sent");
      } else {
        setError(magicData.error || "Could not send login link. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode() {
    if (!sessionId || code.length < 4) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/portal/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, code }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        window.location.href = "/";
      } else {
        setError(data.error === "invalid_code" ? "That code didn't match. Try again." : (data.error || "Verification failed."));
      }
    } catch {
      setError("Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  async function resendCode(opts?: { channel?: "sms" | "email" }) {
    if (!sessionId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/portal/otp/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, channel: opts?.channel }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.channel) setChannel(data.channel);
        if (data.masked_destination) setMaskedDestination(data.masked_destination);
        setResendCountdown(60);
        setCode("");
      } else if (data.error === "rate_limited") {
        setError(`Wait ${data.retry_after_seconds}s before resending`);
      } else {
        setError(data.error || "Could not resend.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function switchToMagicLink() {
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
        setStage("magic_sent");
      } else {
        setError(data.error || "Could not send login link.");
      }
    } finally {
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

  if (stage === "auto_logging") {
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

  if (stage === "magic_sent") {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
        {logoEl}
        <div style={{ fontSize: 48, marginBottom: 16 }}>📧</div>
        <h1 style={{ fontSize: 24, fontWeight: 900, marginBottom: 8 }}>Check your email</h1>
        <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 15 }}>
          We sent a login link to your email. Click the link to access your account.
        </p>
        <button
          onClick={() => { setStage("email"); setEmail(""); setError(""); }}
          style={{ color: primaryColor, fontSize: 14, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
        >
          Try a different email
        </button>
      </div>
    );
  }

  if (stage === "code") {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center", padding: "0 20px" }}>
        {logoEl}
        <h1 style={{ fontSize: 24, fontWeight: 900, marginBottom: 8 }}>Enter your code</h1>
        <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 15 }}>
          We sent a 6-digit code to <strong>{maskedDestination}</strong>.
        </p>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter" && code.length >= 4) verifyCode(); }}
          placeholder="••••••"
          style={{
            padding: "14px 16px", borderRadius: 12, border: "1px solid #e5e7eb",
            fontSize: 24, outline: "none", width: "100%", boxSizing: "border-box",
            textAlign: "center", letterSpacing: "0.6em", fontFamily: "monospace",
          }}
        />
        {error && <p style={{ color: "#dc2626", marginTop: 12, fontSize: 14 }}>{error}</p>}
        <button
          onClick={verifyCode}
          disabled={loading || code.length < 4}
          style={{
            marginTop: 16, padding: "14px 24px", borderRadius: 12, border: "none",
            background: primaryColor, color: "#fff", fontSize: 16, fontWeight: 700,
            cursor: loading ? "wait" : "pointer", opacity: (loading || code.length < 4) ? 0.6 : 1,
            width: "100%",
          }}
        >
          {loading ? "Verifying…" : "Verify & log in"}
        </button>

        <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 12, fontSize: 13 }}>
          <button
            disabled={loading || resendCountdown > 0}
            onClick={() => resendCode()}
            style={{ background: "none", border: "none", color: "#6b7280", cursor: resendCountdown > 0 ? "not-allowed" : "pointer", textDecoration: "underline" }}
          >
            {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : "Resend code"}
          </button>
          {channel === "sms" && (
            <>
              <span style={{ color: "#d4d4d8" }}>·</span>
              <button
                disabled={loading}
                onClick={() => resendCode({ channel: "email" })}
                style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", textDecoration: "underline" }}
              >
                Email me a code instead
              </button>
            </>
          )}
          {channel === "email" && hasSms && (
            <>
              <span style={{ color: "#d4d4d8" }}>·</span>
              <button
                disabled={loading}
                onClick={() => resendCode({ channel: "sms" })}
                style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", textDecoration: "underline" }}
              >
                Text me a code instead
              </button>
            </>
          )}
          <span style={{ color: "#d4d4d8" }}>·</span>
          <button
            disabled={loading}
            onClick={switchToMagicLink}
            style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", textDecoration: "underline" }}
          >
            Email me a login link instead
          </button>
        </div>

        <button
          onClick={() => { setStage("email"); setCode(""); setError(""); }}
          style={{ marginTop: 16, color: primaryColor, fontSize: 13, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
        >
          Use a different email
        </button>
      </div>
    );
  }

  // stage === "email"
  return (
    <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center", padding: "0 20px" }}>
      {logoEl}
      <h1 style={{ fontSize: 28, fontWeight: 900, marginBottom: 8, color: "#18181b" }}>My Account</h1>
      <p style={{ color: "#6b7280", marginBottom: 32, fontSize: 15 }}>
        Enter your email and we&apos;ll send a 6-digit code to log in.
      </p>
      <form onSubmit={handleEmailSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
