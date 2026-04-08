"use client";

import { useEffect, useRef } from "react";

export default function PortalClient({ shopDomain, shopifyCustomerId }: { shopDomain: string; shopifyCustomerId: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    // Set portal config on window
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__PORTAL_CONFIG__ = {
      endpoint: "/api/portal",
      shop: shopDomain,
      logged_in_customer_id: shopifyCustomerId,
      minisite: true,
    };

    // Load CSS if not already loaded
    if (!document.querySelector('link[href="/portal-assets/portal.min.css"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/portal-assets/portal.min.css";
      document.head.appendChild(link);
    }

    // Load portal JS
    const script = document.createElement("script");
    script.src = "/portal-assets/subscription-portal.js";
    script.async = true;
    script.onload = () => {
      console.log("[portal] subscription-portal.js loaded");
    };
    script.onerror = (e) => {
      console.error("[portal] Failed to load subscription-portal.js", e);
    };
    document.body.appendChild(script);

    return () => {
      // Cleanup on unmount
      try { document.body.removeChild(script); } catch {}
    };
  }, [shopDomain, shopifyCustomerId]);

  return (
    <div>
      <h1 style={{ fontSize: "24px", fontWeight: 900, marginBottom: "16px" }}>Manage your subscriptions</h1>
      <div id="subscriptions-portal-root" ref={rootRef} />
    </div>
  );
}
