"use client";

import { useEffect, useRef } from "react";

export default function PortalClient({ shopDomain, shopifyCustomerId }: { shopDomain: string; shopifyCustomerId: string }) {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Set portal config
    (window as unknown as Record<string, unknown>).__PORTAL_CONFIG__ = {
      endpoint: "/api/portal",
      shop: shopDomain,
      logged_in_customer_id: shopifyCustomerId,
      minisite: true,
    };

    // Load CSS
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/portal-assets/portal.min.css";
    document.head.appendChild(link);

    // Load JS
    const script = document.createElement("script");
    script.src = "/portal-assets/subscription-portal.js";
    script.defer = true;
    document.body.appendChild(script);
  }, [shopDomain, shopifyCustomerId]);

  return (
    <div>
      <h1 style={{ fontSize: "24px", fontWeight: 900, marginBottom: "16px" }}>Manage your subscriptions</h1>
      <div id="subscription-portal-root" />
    </div>
  );
}
