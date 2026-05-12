"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface PortalConfig {
  general: {
    lock_days: number;
    shipping_protection_product_ids: string[];
    products_available_to_add: string[];
    rewards_url: string;
    payment_update_url: string;
  };
  shopify: {
    enabled: boolean;
    proxy_path: string;
  };
  minisite: {
    enabled: boolean;
    subdomain: string;
    custom_domain: string;
    logo_url: string;
    primary_color: string;
    auth_method: string;
  };
}

interface ShopifyProduct {
  id: string;
  shopify_product_id: string;
  title: string;
  image_url: string | null;
}

// ---- Primitives ----

function Toggle({ checked, onChange, label, description }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; description?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{label}</h3>
        {description && <p className="mt-0.5 text-xs text-zinc-400">{description}</p>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`}
      >
        <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${checked ? "translate-x-4" : ""}`} />
      </button>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, description, type = "text" }: {
  label: string; value: string | number; onChange: (v: string) => void; placeholder?: string; description?: string; type?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</label>
      {description && <p className="mt-0.5 text-xs text-zinc-400">{description}</p>}
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
    </div>
  );
}

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-zinc-400">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function ProductMultiSelect({ label, description, products, selected, onChange }: {
  label: string; description?: string; products: ShopifyProduct[];
  selected: string[]; onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <div>
      <div className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</div>
      {description && <p className="mt-0.5 text-xs text-zinc-400">{description}</p>}
      <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700">
        {!products.length && <p className="p-3 text-xs text-zinc-400">No products synced yet. Run a Shopify sync first.</p>}
        {products.map((p) => {
          const pid = p.shopify_product_id || p.id;
          const isSelected = selected.includes(pid);
          return (
            <div key={pid}
              onClick={() => toggle(pid)}
              className={`flex cursor-pointer items-center gap-3 border-b border-zinc-100 px-3 py-2 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50 ${
                isSelected ? "bg-violet-50 dark:bg-violet-950/30" : ""
              }`}
            >
              <div className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                isSelected ? "border-violet-600 bg-violet-600 text-white" : "border-zinc-300 dark:border-zinc-600"
              }`}>
                {isSelected && <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
              </div>
              {p.image_url && <img src={p.image_url} alt={p.title} className="h-8 w-8 rounded object-cover" />}
              <span className="text-sm text-zinc-700 dark:text-zinc-300">{p.title}</span>
              {p.shopify_product_id && <span className="text-xs text-zinc-400 ml-auto">{p.shopify_product_id}</span>}
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-zinc-400">{selected.length} selected</p>
    </div>
  );
}

// ---- Main ----

export default function PortalSettingsPage() {
  const workspace = useWorkspace();
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [configRes, productsRes] = await Promise.all([
        fetch(`/api/workspaces/${workspace.id}/portal`),
        fetch(`/api/workspaces/${workspace.id}/products?channel=online_store&limit=200`),
      ]);
      if (cancelled) return;
      if (configRes.ok) setConfig(await configRes.json());
      if (productsRes.ok) {
        const data = await productsRes.json();
        setProducts(Array.isArray(data) ? data : data.products || []);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspace.id]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setSaved(false);
    const res = await fetch(`/api/workspaces/${workspace.id}/portal`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (res.ok) {
      setConfig(await res.json());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  };

  const updateGeneral = (key: string, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, general: { ...config.general, [key]: value } });
  };

  const updateMinisite = (key: string, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, minisite: { ...config.minisite, [key]: value } });
  };

  if (loading || !config) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading portal settings...</p>
      </div>
    );
  }

  // Filter shipping protection products by title
  const shippingProtectionProducts = products.filter((p) => {
    const t = p.title.toLowerCase();
    return t.includes('ship') || t.includes('protection');
  });

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Customer Portal</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Configure your subscription management portal. Deploy as a Shopify theme extension or a standalone mini-site.
          </p>
        </div>
        <button onClick={handleSave} disabled={saving}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
          {saving ? "Saving..." : saved ? "Saved!" : "Save changes"}
        </button>
      </div>

      <div className="space-y-6">
        {/* General */}
        <Card title="General" description="Settings that apply to all portal deployment modes.">
          <Field label="Lock window (days)" type="number" value={config.general.lock_days}
            onChange={(v) => updateGeneral("lock_days", parseInt(v) || 7)}
            description="Subscriptions younger than this are read-only. Prevents edits before first delivery." />
          <Field label="Rewards page URL" value={config.general.rewards_url}
            onChange={(v) => updateGeneral("rewards_url", v)}
            placeholder="https://yourstore.com/pages/rewards"
            description="Link to your rewards/points page (Smile.io, etc.)." />
          <Field label="Payment update URL" value={config.general.payment_update_url || ""}
            onChange={(v) => updateGeneral("payment_update_url", v)}
            placeholder="https://account.yourstore.com/profile"
            description="Where to send customers to update their payment method (used in dunning emails)." />
        </Card>

        {/* Products */}
        <Card title="Portal Products" description="Select which products customers can add, swap, or toggle in the portal.">
          <ProductMultiSelect
            label="Products available to add/swap"
            description="Customers can add or swap to these products in the portal."
            products={products}
            selected={config.general.products_available_to_add}
            onChange={(ids) => updateGeneral("products_available_to_add", ids)}
          />
          <ProductMultiSelect
            label="Shipping protection product"
            description="Auto-filtered to products with &quot;ship&quot; or &quot;protection&quot; in the title."
            products={shippingProtectionProducts}
            selected={config.general.shipping_protection_product_ids || []}
            onChange={(ids) => updateGeneral("shipping_protection_product_ids", ids)}
          />
        </Card>

        {/* Shopify Extension */}
        <Card title="Shopify Extension" description="Deploy the portal as a Shopify theme block.">
          <Toggle checked={config.shopify.enabled}
            onChange={(v) => setConfig({ ...config, shopify: { ...config.shopify, enabled: v } })}
            label="Enable Shopify extension"
            description="Allow the portal to run as a Shopify theme block via app proxy." />
          <div className="rounded-md border border-violet-200 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-950/30">
            <p className="text-sm font-medium text-violet-900 dark:text-violet-100">Setup instructions</p>
            <ol className="mt-2 space-y-1 text-xs text-violet-700 dark:text-violet-300 list-decimal list-inside">
              <li>Add the <strong>Subscriptions Portal</strong> block to a page in your Shopify theme editor</li>
              <li>Paste the workspace ID below into the block&apos;s <strong>ShopCX Workspace ID</strong> field</li>
              <li>Save and publish</li>
            </ol>
            <div className="mt-3">
              <div className="block text-xs font-medium text-violet-800 dark:text-violet-200 mb-1">Workspace ID</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 break-all rounded-md bg-white px-3 py-2 text-xs font-mono text-zinc-800 border border-violet-200 dark:bg-zinc-900 dark:text-zinc-200 dark:border-violet-700">
                  {workspace.id}
                </code>
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(workspace.id); }}
                  className="flex-shrink-0 rounded-md bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-700 transition-colors"
                >
                  Copy
                </button>
              </div>
            </div>
          </div>
        </Card>

        {/* Mini-site */}
        <Card title="Mini-site" description="Host a standalone portal outside of Shopify (like the help center).">
          <Toggle checked={config.minisite.enabled}
            onChange={(v) => updateMinisite("enabled", v)}
            label="Enable mini-site"
            description="Host the customer portal on a subdomain or custom domain." />
          {config.minisite.enabled && (
            <>
              <Field label="Custom domain" value={config.minisite.custom_domain}
                onChange={(v) => updateMinisite("custom_domain", v)}
                placeholder="portal.yourdomain.com"
                description="Enter the subdomain you want to use, then save. We'll register it with Vercel automatically — you only need to add the CNAME record below." />
              {config.minisite.custom_domain && (
                <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
                  <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Add this DNS record at your domain provider:</p>
                  <p className="mt-1 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                    CNAME {config.minisite.custom_domain} → cname.vercel-dns.com
                  </p>
                  <p className="mt-2 text-[11px] text-emerald-700/70 dark:text-emerald-400/70">
                    SSL provisions automatically once the CNAME resolves (usually within a few minutes).
                  </p>
                </div>
              )}
              <div>
                <div className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Authentication method</div>
                <p className="mt-0.5 text-xs text-zinc-400">How customers log in to the mini-site.</p>
                <select value={config.minisite.auth_method}
                  onChange={(e) => updateMinisite("auth_method", e.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
                  <option value="">Not configured</option>
                  <option value="shopify_multipass">Shopify Multipass (Plus)</option>
                  <option value="shopify_oauth">Shopify Customer Account OAuth</option>
                  <option value="magic_link">Magic link via email</option>
                </select>
              </div>
              <Field label="Logo URL" value={config.minisite.logo_url}
                onChange={(v) => updateMinisite("logo_url", v)} placeholder="https://..." />
              <Field label="Primary color" value={config.minisite.primary_color}
                onChange={(v) => updateMinisite("primary_color", v)} placeholder="#000000" />
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
