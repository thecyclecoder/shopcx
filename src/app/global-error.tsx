"use client";

/**
 * Root global error boundary (client-error-capture spec, Phase 1).
 *
 * Next's App Router renders this when an error escapes the ROOT layout — the
 * last-resort boundary that replaces the whole document. We use it to report the
 * crash to /api/client-errors (the surface is classified from the live path, so a
 * root crash on the PDP is still surface 'storefront-pdp') before showing a minimal
 * fallback. The per-surface <ClientErrorReporter> covers everything below the root;
 * this covers the root itself.
 *
 * Fail-open: reporting is best-effort and never blocks the fallback.
 */

import { useEffect } from "react";
import { classifySurface, reportClientError } from "@/lib/client-error-reporter";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    try {
      reportClientError({
        surface: classifySurface(typeof window !== "undefined" ? window.location.pathname : ""),
        message: error?.message || "Root render crash",
        stack: error?.stack || null,
      });
    } catch {
      /* fail-open */
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#ffffff",
          color: "#18181b",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>Something went wrong.</h1>
          <p style={{ marginTop: "0.5rem", color: "#71717a", fontSize: "0.875rem" }}>
            Please try again.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "1px solid #d4d4d8",
              background: "#18181b",
              color: "#fff",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
