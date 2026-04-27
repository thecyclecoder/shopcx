"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface DesignSettings {
  font_key: string | null;
  primary_color: string | null;
  accent_color: string | null;
  logo_url: string | null;
  off_platform_review_count: number;
}

const FONT_OPTIONS: Array<{ key: string; label: string; sample: string }> = [
  { key: "montserrat", label: "Montserrat", sample: "Aa — The quick brown fox" },
  { key: "inter", label: "Inter", sample: "Aa — The quick brown fox" },
  { key: "poppins", label: "Poppins", sample: "Aa — The quick brown fox" },
  { key: "lato", label: "Lato", sample: "Aa — The quick brown fox" },
  { key: "open-sans", label: "Open Sans", sample: "Aa — The quick brown fox" },
  { key: "work-sans", label: "Work Sans", sample: "Aa — The quick brown fox" },
  { key: "nunito-sans", label: "Nunito Sans", sample: "Aa — The quick brown fox" },
  { key: "playfair", label: "Playfair Display", sample: "Aa — The quick brown fox" },
];

const FONT_STACK: Record<string, string> = {
  montserrat: '"Montserrat", system-ui, sans-serif',
  inter: '"Inter", system-ui, sans-serif',
  poppins: '"Poppins", system-ui, sans-serif',
  lato: '"Lato", system-ui, sans-serif',
  "open-sans": '"Open Sans", system-ui, sans-serif',
  "work-sans": '"Work Sans", system-ui, sans-serif',
  "nunito-sans": '"Nunito Sans", system-ui, sans-serif',
  playfair: '"Playfair Display", Georgia, serif',
};

const DEFAULT_PRIMARY = "#18181b";
const DEFAULT_ACCENT = "#10b981";

export default function StorefrontDesignPage() {
  const workspace = useWorkspace();
  const [settings, setSettings] = useState<DesignSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/storefront-design`);
    if (res.ok) setSettings(await res.json());
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  const update = async (patch: Partial<DesignSettings>) => {
    setSaving(true);
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/workspaces/${workspace.id}/storefront-design`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setError(err.error || "Save failed");
    } else {
      setMessage("Saved");
      setTimeout(() => setMessage(null), 2000);
      await load();
    }
    setSaving(false);
  };

  const uploadLogo = async (file: File) => {
    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("slot", "workspace_logo");
    fd.append("workspace_scope", "1");
    const res = await fetch(
      `/api/workspaces/${workspace.id}/storefront-design/logo`,
      { method: "POST", body: fd },
    );
    if (res.ok) {
      const body = await res.json();
      await update({ logo_url: body.url });
    } else {
      const err = await res.json().catch(() => ({}));
      setError(err.error || "Upload failed");
    }
    setUploading(false);
  };

  if (!settings) {
    return <div className="p-8 text-sm text-zinc-400">Loading...</div>;
  }

  const fontKey = settings.font_key || "montserrat";
  const primary = settings.primary_color || DEFAULT_PRIMARY;
  const accent = settings.accent_color || DEFAULT_ACCENT;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Storefront Design</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Font, colors, and logo applied to every storefront page. Changes propagate immediately.
        </p>
      </div>

      {message && (
        <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {message}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Font */}
      <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Font</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Pick from a pre-registered Google Fonts allowlist. Switching requires a Vercel rebuild to take effect on
          cached pages, but the preview below is live.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {FONT_OPTIONS.map((f) => (
            <button
              key={f.key}
              onClick={() => update({ font_key: f.key })}
              disabled={saving}
              className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-all ${
                fontKey === f.key
                  ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30"
                  : "border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900"
              }`}
            >
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{f.label}</span>
              <span
                className="text-lg text-zinc-600 dark:text-zinc-400"
                style={{ fontFamily: FONT_STACK[f.key] }}
              >
                {f.sample}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Colors */}
      <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Colors</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <ColorField
            label="Primary"
            hint="Hero background, primary buttons"
            value={primary}
            defaultValue={DEFAULT_PRIMARY}
            onSave={(v) => update({ primary_color: v })}
            saving={saving}
          />
          <ColorField
            label="Accent"
            hint="Savings badges, highlights"
            value={accent}
            defaultValue={DEFAULT_ACCENT}
            onSave={(v) => update({ accent_color: v })}
            saving={saving}
          />
        </div>
      </section>

      {/* Logo */}
      <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Logo</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Transcoded to WebP + AVIF on upload. PNG with transparent background recommended.
        </p>

        <div className="flex items-center gap-4">
          <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-md border border-dashed border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800">
            {settings.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={settings.logo_url} alt="Logo" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="text-[10px] text-zinc-400">No logo</span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadLogo(f);
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              {uploading ? "Uploading..." : "Upload logo"}
            </button>
            {settings.logo_url && (
              <button
                onClick={() => update({ logo_url: null })}
                className="text-xs text-red-500 hover:text-red-700"
                disabled={saving}
              >
                Remove logo
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Off-platform reviews */}
      <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Off-platform reviews</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Bump every product&apos;s review count by this amount to account for reviews collected on Amazon, Klaviyo, etc.
          Added to both the per-product star count and the all-reviews page total.
        </p>
        <ReviewCountField
          value={settings.off_platform_review_count}
          onSave={(n) => update({ off_platform_review_count: n })}
          saving={saving}
        />
      </section>

      {/* Preview */}
      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Preview</h2>
        <div
          className="rounded-md border border-zinc-200 p-6 dark:border-zinc-800"
          style={{ fontFamily: FONT_STACK[fontKey] }}
        >
          <h3 className="text-2xl font-bold" style={{ color: primary }}>
            The Energy Your Body Has Been Missing
          </h3>
          <p className="mt-2 text-sm text-zinc-600">
            A sample headline in your chosen font and primary color.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <button
              className="rounded-full px-4 py-2 text-sm font-semibold text-white"
              style={{ backgroundColor: primary }}
            >
              Primary button
            </button>
            <span
              className="rounded-full px-3 py-1 text-xs font-semibold"
              style={{ backgroundColor: `${accent}22`, color: accent }}
            >
              Save 25%
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

function ColorField({
  label,
  hint,
  value,
  defaultValue,
  onSave,
  saving,
}: {
  label: string;
  hint: string;
  value: string;
  defaultValue: string;
  onSave: (v: string) => void;
  saving: boolean;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  const commit = () => {
    if (local !== value) onSave(local);
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs font-medium text-zinc-500">{label}</label>
        {value !== defaultValue && (
          <button
            onClick={() => onSave(defaultValue)}
            className="text-[10px] text-zinc-400 hover:text-zinc-600"
          >
            Reset
          </button>
        )}
      </div>
      <p className="mb-2 text-[10px] text-zinc-400">{hint}</p>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          disabled={saving}
          className="h-10 w-14 cursor-pointer rounded border border-zinc-300 bg-white p-0 dark:border-zinc-700"
        />
        <input
          type="text"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          disabled={saving}
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
      </div>
    </div>
  );
}

function ReviewCountField({
  value,
  onSave,
  saving,
}: {
  value: number;
  onSave: (n: number) => void;
  saving: boolean;
}) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => setLocal(String(value)), [value]);

  const commit = () => {
    const n = parseInt(local, 10);
    if (!Number.isFinite(n) || n < 0) {
      setLocal(String(value));
      return;
    }
    if (n !== value) onSave(n);
  };

  return (
    <div className="flex items-center gap-3">
      <input
        type="number"
        min={0}
        step={1}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        disabled={saving}
        className="w-40 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      <span className="text-xs text-zinc-500">reviews added to every product</span>
    </div>
  );
}
