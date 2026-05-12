"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface IntegrationCard {
  slug: string;
  name: string;
  description: string;
  icon: string; // SVG path
  iconBg: string;
  connected: boolean;
}

export default function IntegrationsPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [integrations, setIntegrations] = useState<IntegrationCard[]>([]);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/integrations`)
      .then(r => r.json())
      .then(data => {
        setIntegrations([
          {
            slug: "shopify",
            name: "Shopify",
            description: "Store connection, OAuth, customer & order sync",
            icon: "M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z",
            iconBg: "bg-green-600/10",
            connected: !!data.shopify_connected,
          },
          {
            slug: "resend",
            name: "Resend",
            description: "Email sending, inbound webhooks, domain config",
            icon: "M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75",
            iconBg: "bg-violet-600/10",
            connected: !!data.resend_connected,
          },
          {
            slug: "appstle",
            name: "Appstle",
            description: "Subscription management, billing actions",
            icon: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99",
            iconBg: "bg-blue-600/10",
            connected: !!data.appstle_connected,
          },
          {
            slug: "easypost",
            name: "EasyPost",
            description: "Return labels, tracking, address verification",
            icon: "M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12",
            iconBg: "bg-amber-600/10",
            connected: !!data.easypost_connected,
          },
          {
            slug: "klaviyo",
            name: "Klaviyo",
            description: "Product reviews sync, social proof",
            icon: "M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z",
            iconBg: "bg-emerald-600/10",
            connected: !!data.klaviyo_connected,
          },
          {
            slug: "meta",
            name: "Meta",
            description: "Facebook & Instagram messaging",
            icon: "M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z",
            iconBg: "bg-blue-500/10",
            connected: !!data.meta_connected,
          },
          {
            slug: "meta-ads",
            name: "Meta Ads",
            description: "Facebook & Instagram ad spend for ROAS tracking",
            icon: "M10.5 6a7.5 7.5 0 107.5 7.5h-7.5V6z M13.5 10.5H21A7.5 7.5 0 0013.5 3v7.5z",
            iconBg: "bg-blue-600/10",
            connected: !!data.meta_ads_connected,
          },
          {
            slug: "amazon",
            name: "Amazon",
            description: "SP-API sales data, Subscribe & Save, order sync",
            icon: "M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z",
            iconBg: "bg-amber-600/10",
            connected: !!data.amazon_connected,
          },
          {
            slug: "amplifier",
            name: "Amplifier",
            description: "Fulfillment, shipping SLA, tracking",
            icon: "M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9",
            iconBg: "bg-blue-600/10",
            connected: !!data.amplifier_connected,
          },
          {
            slug: "census",
            name: "US Census Bureau",
            description: "Zip-code demographic enrichment — income, education, urban/rural",
            icon: "M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 21h18M12 6.75h.008v.008H12V6.75z",
            iconBg: "bg-indigo-600/10",
            connected: !!data.census_connected,
          },
          {
            slug: "google-seo",
            name: "Google SEO Tools",
            description: "Keyword Planner (search volume) + Search Console (rankings)",
            icon: "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 0z",
            iconBg: "bg-blue-600/10",
            connected: !!(data.google_ads_connected || data.google_search_console_connected),
          },
          {
            slug: "versium",
            name: "Versium REACH",
            description: "Individual-level demographic append — real age, income, interests, household",
            icon: "M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z",
            iconBg: "bg-violet-600/10",
            connected: !!data.versium_connected,
          },
          {
            slug: "slack",
            name: "Slack",
            description: "Team notifications, ticket sharing",
            icon: "M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155",
            iconBg: "bg-purple-600/10",
            connected: !!data.slack_connected,
          },
        ]);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspace.id]);

  if (loading) return <div className="p-8 text-center text-zinc-400">Loading integrations...</div>;

  const connected = integrations.filter(i => i.connected);
  const notConnected = integrations.filter(i => !i.connected);

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Integrations</h1>
        <p className="mt-1 text-sm text-zinc-500">{connected.length} of {integrations.length} connected</p>
      </div>

      {/* Connected */}
      {connected.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Connected</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {connected.map(card => (
              <IntegrationCardComponent key={card.slug} card={card} onClick={() => router.push(`/dashboard/settings/integrations/${card.slug}`)} />
            ))}
          </div>
        </div>
      )}

      {/* Not Connected */}
      {notConnected.length > 0 && (
        <div>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Available</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {notConnected.map(card => (
              <IntegrationCardComponent key={card.slug} card={card} onClick={() => router.push(`/dashboard/settings/integrations/${card.slug}`)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IntegrationCardComponent({ card, onClick }: { card: IntegrationCard; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-left transition-all hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${card.iconBg}`}>
        <svg className="h-5 w-5 text-zinc-600 dark:text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d={card.icon} />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{card.name}</span>
          {card.connected && (
            <span className="h-2 w-2 rounded-full bg-green-500" title="Connected" />
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-zinc-500">{card.description}</p>
      </div>
      <svg className="h-4 w-4 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
      </svg>
    </button>
  );
}
