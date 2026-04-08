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
            slug: "amplifier",
            name: "Amplifier",
            description: "Fulfillment, shipping SLA, tracking",
            icon: "M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9",
            iconBg: "bg-blue-600/10",
            connected: !!data.amplifier_connected,
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
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
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
