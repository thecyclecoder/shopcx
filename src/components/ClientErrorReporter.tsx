"use client";

/**
 * <ClientErrorReporter> — the storefront + in-house-portal client error capture
 * (client-error-capture spec, Phase 1).
 *
 * Two captures in one mount:
 *   1. A global window.onerror / unhandledrejection listener (installed once) —
 *      catches uncaught JS errors and unhandled promise rejections anywhere on
 *      the page (a Braintree tokenize throw, an async fetch reject), classified
 *      by the CURRENT path so one mount in the storefront layout covers the
 *      whole funnel (PDP → customize → checkout → thank-you).
 *   2. A React error boundary around {children} — catches a render crash in a
 *      client island (e.g. the forced-crash test flag) that the window listener
 *      wouldn't see, and reports it with the surface for the current path.
 *
 * Fail-open: a report never blocks rendering; the boundary re-renders {children}
 * (Next's own error.tsx / segment boundaries still own the user-facing fallback).
 * No PII — see src/lib/client-error-reporter.ts.
 *
 * Mounted in (storefront)/layout.tsx and portal/[slug]/layout.tsx, wrapping the
 * subtree. Both are same-origin with the ingest, so origin is "" (relative).
 */

import { Component, useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  classifySurface,
  installWindowErrorReporter,
  reportClientError,
  sendClientErrorHeartbeat,
  type ClientErrorSurface,
} from "@/lib/client-error-reporter";

class ReporterBoundary extends Component<
  { children: ReactNode; getSurface: () => ClientErrorSurface },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    // Swallow into the boundary so a render crash in one island doesn't blank the
    // whole tree; we re-render children on the next pass (fail-open for the user).
    return { crashed: false };
  }

  componentDidCatch(error: Error) {
    try {
      reportClientError({
        surface: this.props.getSurface(),
        message: error?.message || "React render crash",
        stack: error?.stack || null,
      });
    } catch {
      /* fail-open */
    }
  }

  render() {
    return this.props.children;
  }
}

export default function ClientErrorReporter({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // Read the surface from the LIVE path at error time (the storefront SPA navigates).
  const getSurface = () =>
    classifySurface(typeof window !== "undefined" ? window.location.pathname : pathname);

  useEffect(() => {
    const cleanup = installWindowErrorReporter(getSurface);
    sendClientErrorHeartbeat(getSurface());
    return cleanup;
    // Install once for the lifetime of the mount; getSurface reads live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <ReporterBoundary getSurface={getSurface}>{children}</ReporterBoundary>;
}
