"use client";

import { useParams, useRouter } from "next/navigation";
import IntegrationsFullPage from "../_page-full";

const NAMES: Record<string, string> = {
  shopify: "Shopify",
  resend: "Resend",
  appstle: "Appstle",
  easypost: "EasyPost / Returns",
  klaviyo: "Klaviyo",
  meta: "Meta",
  amplifier: "Amplifier",
  slack: "Slack",
  multipass: "Shopify Multipass",
  census: "US Census Bureau",
  versium: "Versium REACH",
};

export default function IntegrationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  return (
    <div>
      <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6">
        <button
          onClick={() => router.push("/dashboard/settings/integrations")}
          className="mb-4 text-sm text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
        >
          &larr; Back to Integrations
        </button>
        <h1 className="mb-6 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {NAMES[slug] || slug}
        </h1>
      </div>
      <IntegrationsFullPage filterSection={slug} />
    </div>
  );
}
