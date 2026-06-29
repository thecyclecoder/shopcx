import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Unlock",
};

// The unlock page is explicitly NOT gated by the proxy (it must be reachable to
// authenticate). It posts a standard form to /api/showcase/unlock, which checks
// the shared password and sets the signed httpOnly session cookie.

export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const from = typeof sp.from === "string" ? sp.from : "";
  const hasError = sp.error === "1";

  return (
    <div className="sc-shell" style={{ display: "grid", placeItems: "center", minHeight: "calc(100dvh - 58px)" }}>
      <div style={{ width: "100%", maxWidth: 420, padding: "32px 0" }}>
        <div className="sc-eyebrow" style={{ marginBottom: 14 }}>Private preview</div>
        <h1 className="sc-h1" style={{ fontSize: "2rem", marginBottom: 10 }}>
          You&apos;re early.
        </h1>
        <p className="sc-lede" style={{ marginBottom: 28, fontSize: "1.02rem" }}>
          This is a private walkthrough of how ShopCX is built — shared by invitation.
          Enter the access phrase to continue.
        </p>

        <form action="/api/showcase/unlock" method="POST" className="sc-card" style={{ padding: 22 }}>
          {from ? <input type="hidden" name="from" value={from} /> : null}
          <label
            htmlFor="showcase-password"
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 8,
              color: "var(--sc-fg-muted)",
            }}
          >
            Access phrase
          </label>
          <input
            id="showcase-password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            placeholder="••••••••"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "11px 14px",
              borderRadius: 10,
              border: `1px solid ${hasError ? "var(--sc-bad)" : "var(--sc-border-strong)"}`,
              background: "var(--sc-bg)",
              color: "var(--sc-fg)",
              fontSize: 15,
              fontFamily: "var(--sc-mono)",
              outline: "none",
            }}
          />
          {hasError ? (
            <p style={{ color: "var(--sc-bad)", fontSize: 13, margin: "10px 0 0" }}>
              That phrase didn&apos;t match. Try again.
            </p>
          ) : null}

          <button
            type="submit"
            style={{
              marginTop: 16,
              width: "100%",
              padding: "11px 14px",
              borderRadius: 10,
              border: "none",
              cursor: "pointer",
              fontSize: 15,
              fontWeight: 600,
              color: "#fff",
              background: "linear-gradient(135deg, var(--sc-accent), var(--sc-accent-2))",
            }}
          >
            Enter showcase
          </button>
        </form>

        <p className="sc-muted" style={{ fontSize: 12.5, marginTop: 18, fontFamily: "var(--sc-mono)" }}>
          No account, no data — a read-only narrative.
        </p>
      </div>
    </div>
  );
}
