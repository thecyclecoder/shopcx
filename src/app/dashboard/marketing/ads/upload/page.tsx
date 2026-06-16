"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface Product { id: string; title: string }

const ARCHETYPES: Array<{ k: string; label: string; hint: string }> = [
  { k: "advertorial", label: "Advertorial", hint: "Editorial article look → advertorial lander" },
  { k: "testimonial", label: "Testimonial", hint: "Customer quote + face → PDP" },
  { k: "authority", label: "Authority", hint: "Expert endorsement → PDP" },
  { k: "big_claim", label: "Big claim", hint: "Contrarian hook poster → PDP" },
  { k: "before_after", label: "Before / After", hint: "Transformation → before/after lander" },
];

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function UploadStaticPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [archetype, setArchetype] = useState("advertorial");
  const [description, setDescription] = useState("");
  const [file45, setFile45] = useState<File | null>(null);
  const [file916, setFile916] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/workspaces/${workspace.id}/products`);
      if (res.ok) {
        const p: Product[] = await res.json();
        setProducts(p);
        if (p[0]) setProductId(p[0].id);
      }
    })();
  }, [workspace.id]);

  const submit = useCallback(async () => {
    setError("");
    if (!productId) return setError("Pick a product.");
    if (!description.trim()) return setError("Describe the image (this grounds the AI ad copy).");
    if (!file45 && !file916) return setError("Upload at least one image (4:5 and/or 9:16).");
    setSubmitting(true);
    try {
      const images: Array<{ format: string; dataUrl: string }> = [];
      if (file45) images.push({ format: "feed_4x5", dataUrl: await readDataUrl(file45) });
      if (file916) images.push({ format: "stories_9x16", dataUrl: await readDataUrl(file916) });
      const res = await fetch(`/api/ads/upload-static`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, productId, archetype, description: description.trim(), images }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "upload failed");
      router.push(`/dashboard/marketing/ads/${json.campaignId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
      setSubmitting(false);
    }
  }, [workspace.id, productId, archetype, description, file45, file916, router]);

  const fileField = (label: string, ratio: string, file: File | null, set: (f: File | null) => void) => (
    <div className="rounded-lg border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
      <div className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">{label} <span className="text-xs font-normal text-zinc-400">({ratio})</span></div>
      {file ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={URL.createObjectURL(file)} alt={label} className="h-24 rounded border border-zinc-200 object-cover dark:border-zinc-700" />
          <button onClick={() => set(null)} className="text-xs text-red-600 hover:underline">Remove</button>
        </div>
      ) : (
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => set(e.target.files?.[0] || null)} className="text-sm text-zinc-600 dark:text-zinc-300" />
      )}
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
      <Link href="/dashboard/marketing/ads" className="text-xs text-indigo-600 hover:underline">← Ads</Link>
      <h1 className="mt-1 mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Upload static ad</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Skip generation — upload a finished image, tag it, and it becomes a publish-ready campaign:
        landers (for advertorial / before-after), angle metadata, and AI Meta copy.
      </p>

      <div className="space-y-5">
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-200">Product</label>
          <select value={productId} onChange={(e) => setProductId(e.target.value)} className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            {products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-200">Category</label>
          <select value={archetype} onChange={(e) => setArchetype(e.target.value)} className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            {ARCHETYPES.map((a) => <option key={a.k} value={a.k}>{a.label}</option>)}
          </select>
          <p className="mt-1 text-xs text-zinc-400">{ARCHETYPES.find((a) => a.k === archetype)?.hint}</p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-200">Describe the image</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
            placeholder="e.g. Older woman holding Amazing Coffee, big claim 'Your coffee is aging you', antioxidant / anti-aging angle."
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          <p className="mt-1 text-xs text-zinc-400">Grounds the AI Meta copy + the lander angle.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {fileField("Feed image", "4:5", file45, setFile45)}
          {fileField("Stories / Reels image", "9:16", file916, setFile916)}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button onClick={submit} disabled={submitting}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
          {submitting ? "Uploading…" : "Create campaign"}
        </button>
      </div>
    </div>
  );
}
