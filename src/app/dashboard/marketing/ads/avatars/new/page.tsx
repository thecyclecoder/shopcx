"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface ArchetypeBrief {
  name?: string;
  wardrobe?: string;
  setting?: string;
  hook_delivery_style?: string;
  photoshoot_brief?: string;
}

interface Proposal {
  id: string;
  archetype_brief: ArchetypeBrief | null;
  products?: { title?: string } | null;
}

export default function NewAvatarPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const proposalId = searchParams.get("proposalId");

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [name, setName] = useState("");
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProposal = useCallback(async () => {
    if (!proposalId) return;
    const res = await fetch(`/api/ads/proposals?workspaceId=${workspace.id}`);
    if (!res.ok) return;
    const list: Proposal[] = await res.json();
    const found = list.find((p) => p.id === proposalId);
    if (found) {
      setProposal(found);
      if (found.archetype_brief?.name) setName(found.archetype_brief.name);
    }
  }, [proposalId, workspace.id]);

  useEffect(() => {
    loadProposal();
  }, [loadProposal]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remaining = 5 - imageUrls.length;
    const chosen = Array.from(files).slice(0, remaining);
    if (chosen.length === 0) {
      setError("Maximum 5 reference photos.");
      return;
    }
    setUploading(true);
    setError(null);
    const uploaded: string[] = [];
    for (const file of chosen) {
      const fd = new FormData();
      fd.append("workspaceId", workspace.id);
      fd.append("file", file);
      const res = await fetch("/api/ads/avatars/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Upload failed.");
        setUploading(false);
        return;
      }
      uploaded.push(json.url);
    }
    setImageUrls((prev) => [...prev, ...uploaded]);
    setUploading(false);
  }

  function removeImage(idx: number) {
    setImageUrls((prev) => prev.filter((_, i) => i !== idx));
  }

  async function createAvatar() {
    if (!name.trim()) {
      setError("Please enter a name.");
      return;
    }
    if (imageUrls.length === 0) {
      setError("Upload at least one reference photo.");
      return;
    }
    setCreating(true);
    setError(null);
    const res = await fetch("/api/ads/avatars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: name.trim(),
        imageUrls,
        proposalId: proposalId ?? undefined,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(
        json.error === "avatar_limit"
          ? "You've reached the maximum of 10 active avatars. Archive one first."
          : json.error || "Failed to create avatar.",
      );
      setCreating(false);
      return;
    }
    router.push("/dashboard/marketing/ads/avatars");
  }

  const brief = proposal?.archetype_brief;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">New avatar</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Upload 1–5 reference photos to create a recurring character.
        </p>
      </div>

      {brief && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Archetype brief{proposal?.products?.title ? ` · ${proposal.products.title}` : ""}
          </h2>
          <dl className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-300">
            {brief.wardrobe && (
              <p>
                <span className="font-medium text-zinc-500 dark:text-zinc-400">Wardrobe:</span>{" "}
                {brief.wardrobe}
              </p>
            )}
            {brief.setting && (
              <p>
                <span className="font-medium text-zinc-500 dark:text-zinc-400">Setting:</span>{" "}
                {brief.setting}
              </p>
            )}
            {brief.hook_delivery_style && (
              <p>
                <span className="font-medium text-zinc-500 dark:text-zinc-400">Delivery:</span>{" "}
                {brief.hook_delivery_style}
              </p>
            )}
            {brief.photoshoot_brief && (
              <p>
                <span className="font-medium text-zinc-500 dark:text-zinc-400">Photoshoot:</span>{" "}
                {brief.photoshoot_brief}
              </p>
            )}
          </dl>
        </div>
      )}

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Morning-routine Mia"
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />

        <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
          Reference photos ({imageUrls.length}/5)
        </label>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          disabled={uploading || imageUrls.length >= 5}
          onChange={(e) => handleFiles(e.target.files)}
          className="mt-1 block w-full text-sm text-zinc-600 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 dark:text-zinc-300 dark:file:bg-zinc-800 dark:file:text-zinc-200"
        />
        {uploading && (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Uploading…</p>
        )}

        {imageUrls.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {imageUrls.map((url, idx) => (
              <div key={url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="h-16 w-16 rounded-md object-cover" />
                <button
                  onClick={() => removeImage(idx)}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900 text-xs text-white"
                  aria-label="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Creating an avatar costs 40 Higgsfield credits (≈ $2.50).
      </p>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={createAvatar}
          disabled={creating || uploading}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create avatar"}
        </button>
        <button
          onClick={() => router.push("/dashboard/marketing/ads/avatars")}
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
