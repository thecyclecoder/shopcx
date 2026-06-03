"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { LIFE_FORCE_8 } from "@/lib/ad-tool-config";

interface Avatar {
  id: string;
  name: string;
  reference_image_urls: string[] | null;
}

interface Product {
  id: string;
  title: string;
  image_url: string | null;
}

interface Angle {
  id: string;
  hook_slug: string;
  lf8_slot: number;
  hook_one_liner: string;
  proof_anchor: { type: string; value: string } | null;
  vibe_tags: string[] | null;
  meta_headline: string;
}

interface Violation {
  code: string;
  severity: string;
  message: string;
}

interface ScriptResult {
  ok: boolean;
  script: string;
  hook: string;
  body: string;
  cta: string;
  violations: Violation[];
}

const VOICE_OPTIONS = ["energetic", "direct", "urgent"];

export default function NewAdPage() {
  const workspace = useWorkspace();
  const router = useRouter();

  // Step state
  const [avatars, setAvatars] = useState<Avatar[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [angles, setAngles] = useState<Angle[]>([]);

  const [avatarId, setAvatarId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [angleId, setAngleId] = useState<string | null>(null);
  const [lengthSec, setLengthSec] = useState<15 | 30>(30);
  const [also15, setAlso15] = useState(false);
  const [voiceId, setVoiceId] = useState<string>("energetic");

  // Script editor
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [hook, setHook] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [cta, setCta] = useState("");
  const [violations, setViolations] = useState<Violation[]>([]);

  // Async / status
  const [loadingAngles, setLoadingAngles] = useState(false);
  const [generatingAngles, setGeneratingAngles] = useState(false);
  const [creating, setCreating] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Media
  const [heroUrl, setHeroUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [heroBusy, setHeroBusy] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);

  // Load avatars + products on mount
  useEffect(() => {
    (async () => {
      const aRes = await fetch(`/api/ads/avatars?workspaceId=${workspace.id}`);
      setAvatars(aRes.ok ? await aRes.json() : []);
      const pRes = await fetch(`/api/workspaces/${workspace.id}/products`);
      if (pRes.ok) setProducts(await pRes.json());
    })();
  }, [workspace.id]);

  const loadAngles = useCallback(
    async (pid: string) => {
      setLoadingAngles(true);
      const res = await fetch(`/api/ads/angles?workspaceId=${workspace.id}&productId=${pid}`);
      setAngles(res.ok ? await res.json() : []);
      setLoadingAngles(false);
    },
    [workspace.id],
  );

  useEffect(() => {
    if (productId) {
      setAngleId(null);
      loadAngles(productId);
    }
  }, [productId, loadAngles]);

  async function generateAngles() {
    if (!productId) return;
    setGeneratingAngles(true);
    setError(null);
    const res = await fetch("/api/ads/angles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, productId }),
    });
    if (res.ok) {
      await loadAngles(productId);
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.reason || d.error || "Failed to generate angles");
    }
    setGeneratingAngles(false);
  }

  function applyScript(s: ScriptResult) {
    setHook(s.hook);
    setBodyText(s.body);
    setCta(s.cta);
    setViolations(s.violations || []);
  }

  async function createCampaign() {
    if (!productId || !angleId) return;
    setCreating(true);
    setError(null);
    const res = await fetch("/api/ads/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        productId,
        avatarId,
        angleId,
        lengthSec,
        voiceId,
      }),
    });
    if (res.ok) {
      const d = await res.json();
      setCampaignId(d.campaign.id);
      setHeroUrl(d.campaign.hero_image_url || null);
      setAudioUrl(d.campaign.audio_url || null);
      applyScript(d.script);
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Failed to create campaign");
    }
    setCreating(false);
  }

  async function saveScript() {
    if (!campaignId) return;
    const script_text = [hook, bodyText, cta].filter(Boolean).join("\n");
    await fetch(`/api/ads/campaigns/${campaignId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, script_text, voice_id: voiceId }),
    });
  }

  async function validate() {
    if (!productId) return;
    setValidating(true);
    const script_text = [hook, bodyText, cta].filter(Boolean).join("\n");
    const res = await fetch("/api/ads/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        productId,
        angleId,
        script: script_text,
      }),
    });
    if (res.ok) {
      const d = await res.json();
      setViolations(d.violations || []);
    }
    setValidating(false);
  }

  async function regenerate() {
    // Simplest: re-create the campaign with a fresh script and replace.
    await createCampaign();
  }

  async function pollCampaign() {
    if (!campaignId) return;
    const res = await fetch(`/api/ads/campaigns/${campaignId}?workspaceId=${workspace.id}`);
    if (res.ok) {
      const d = await res.json();
      setHeroUrl(d.campaign.hero_image_url || null);
      setAudioUrl(d.campaign.audio_url || null);
    }
  }

  async function generateHero() {
    if (!campaignId) return;
    setHeroBusy(true);
    await fetch(`/api/ads/campaigns/${campaignId}/hero`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    setHeroBusy(false);
  }

  async function generateAudio() {
    if (!campaignId) return;
    setAudioBusy(true);
    await saveScript();
    await fetch(`/api/ads/campaigns/${campaignId}/audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    setAudioBusy(false);
  }

  const selectedProduct = products.find((p) => p.id === productId);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <Link href="/dashboard/marketing/ads" className="text-xs text-indigo-600 hover:underline">
        ← Ads
      </Link>
      <h1 className="mt-1 mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">New ad</h1>
      <p className="mb-8 text-sm text-zinc-500">Build a direct-response ad step by step.</p>

      {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

      {/* 1. Avatar */}
      <Step n={1} title="Pick an avatar">
        {avatars === null ? (
          <p className="text-sm text-zinc-500">Loading avatars…</p>
        ) : avatars.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No avatars —{" "}
            <Link href="/dashboard/marketing/ads/avatars/new" className="text-indigo-600 hover:underline">
              create one
            </Link>
            .
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {avatars.map((a) => (
              <label
                key={a.id}
                className={`cursor-pointer rounded-lg border p-3 ${
                  avatarId === a.id
                    ? "border-indigo-500 ring-1 ring-indigo-500"
                    : "border-zinc-200 dark:border-zinc-800"
                } bg-white dark:bg-zinc-900`}
              >
                <input
                  type="radio"
                  name="avatar"
                  className="sr-only"
                  checked={avatarId === a.id}
                  onChange={() => setAvatarId(a.id)}
                />
                {a.reference_image_urls?.[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={a.reference_image_urls[0]}
                    alt={a.name}
                    className="mb-2 aspect-square w-full rounded object-cover"
                  />
                )}
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{a.name}</p>
              </label>
            ))}
          </div>
        )}
      </Step>

      {/* 2. Product */}
      <Step n={2} title="Pick a product">
        {products.length === 0 ? (
          <p className="text-sm text-zinc-500">No products found.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {products.map((p) => (
              <label
                key={p.id}
                className={`cursor-pointer rounded-lg border p-3 ${
                  productId === p.id
                    ? "border-indigo-500 ring-1 ring-indigo-500"
                    : "border-zinc-200 dark:border-zinc-800"
                } bg-white dark:bg-zinc-900`}
              >
                <input
                  type="radio"
                  name="product"
                  className="sr-only"
                  checked={productId === p.id}
                  onChange={() => setProductId(p.id)}
                />
                {p.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.image_url}
                    alt={p.title}
                    className="mb-2 aspect-square w-full rounded object-cover"
                  />
                )}
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.title}</p>
              </label>
            ))}
          </div>
        )}
      </Step>

      {/* 3. Angle */}
      {productId && (
        <Step n={3} title="Pick an angle">
          <div className="mb-3">
            <button
              onClick={generateAngles}
              disabled={generatingAngles}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {generatingAngles ? "Generating…" : "Generate fresh angles"}
            </button>
          </div>
          {loadingAngles ? (
            <p className="text-sm text-zinc-500">Loading angles…</p>
          ) : angles.length === 0 ? (
            <p className="text-sm text-zinc-500">No angles yet. Generate some above.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {angles.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAngleId(a.id)}
                  className={`rounded-lg border p-3 text-left ${
                    angleId === a.id
                      ? "border-indigo-500 ring-1 ring-indigo-500"
                      : "border-zinc-200 dark:border-zinc-800"
                  } bg-white dark:bg-zinc-900`}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                      {a.hook_slug}
                    </span>
                    <span
                      className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      title={LIFE_FORCE_8[a.lf8_slot]}
                    >
                      LF8 #{a.lf8_slot}
                    </span>
                  </div>
                  <p className="text-sm text-zinc-900 dark:text-zinc-100">{a.hook_one_liner}</p>
                  {a.proof_anchor?.value && (
                    <p className="mt-1 text-xs text-zinc-500">Proof: {a.proof_anchor.value}</p>
                  )}
                </button>
              ))}
            </div>
          )}
        </Step>
      )}

      {/* 4. Length */}
      {angleId && (
        <Step n={4} title="Length">
          <div className="flex flex-wrap items-center gap-4">
            {[15, 30].map((len) => (
              <label key={len} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="length"
                  checked={lengthSec === len}
                  onChange={() => setLengthSec(len as 15 | 30)}
                />
                {len}s
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <input type="checkbox" checked={also15} onChange={(e) => setAlso15(e.target.checked)} />
              Also produce a 15s cut
            </label>
          </div>
        </Step>
      )}

      {/* 5. Script */}
      {angleId && (
        <Step n={5} title="Script">
          {!campaignId ? (
            <button
              onClick={createCampaign}
              disabled={creating}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {creating ? "Generating script…" : "Generate script"}
            </button>
          ) : (
            <div className="space-y-4">
              <Field label="Hook" value={hook} onChange={setHook} rows={2} />
              <Field label="Body" value={bodyText} onChange={setBodyText} rows={5} />
              <Field label="CTA" value={cta} onChange={setCta} rows={2} />

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={validate}
                  disabled={validating}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {validating ? "Validating…" : "Validate"}
                </button>
                <button
                  onClick={regenerate}
                  disabled={creating}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Regenerate
                </button>
                <button
                  onClick={saveScript}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
                >
                  Save script
                </button>
              </div>

              {violations.length > 0 && (
                <ul className="space-y-1">
                  {violations.map((v, i) => (
                    <li key={i} className="text-xs text-red-500">
                      [{v.severity}] {v.code}: {v.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Step>
      )}

      {/* 6. Voice */}
      {campaignId && (
        <Step n={6} title="Voice">
          <select
            value={voiceId}
            onChange={async (e) => {
              setVoiceId(e.target.value);
              await fetch(`/api/ads/campaigns/${campaignId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ workspaceId: workspace.id, voice_id: e.target.value }),
              });
            }}
            className="w-full max-w-xs rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          >
            {VOICE_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Step>
      )}

      {/* 7. Media */}
      {campaignId && (
        <Step n={7} title="Hero & audio">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={generateHero}
              disabled={heroBusy}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {heroBusy ? "Queuing…" : "Generate hero"}
            </button>
            <button
              onClick={generateAudio}
              disabled={audioBusy}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {audioBusy ? "Queuing…" : "Generate audio"}
            </button>
            <button
              onClick={pollCampaign}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Refresh
            </button>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Hero</p>
              {heroUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={heroUrl} alt="Hero" className="w-full rounded" />
              ) : (
                <p className="text-xs text-zinc-400">Not generated yet.</p>
              )}
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Audio</p>
              {audioUrl ? (
                <audio controls src={audioUrl} className="w-full" />
              ) : (
                <p className="text-xs text-zinc-400">Not generated yet.</p>
              )}
            </div>
          </div>

          <div className="mt-6">
            <Link
              href={`/dashboard/marketing/ads/${campaignId}`}
              className="text-sm text-indigo-600 hover:underline"
            >
              Go to ad detail →
            </Link>
          </div>
        </Step>
      )}

      {selectedProduct && (
        <p className="mt-8 text-xs text-zinc-400">Building for: {selectedProduct.title}</p>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
        <span className="text-[10px] text-zinc-400">{value.length} chars</span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      />
    </div>
  );
}
