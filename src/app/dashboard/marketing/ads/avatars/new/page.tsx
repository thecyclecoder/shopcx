"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import {
  AVATAR_GENDERS,
  AVATAR_AGE_RANGES,
  AVATAR_HEALTH_LEVELS,
  AVATAR_ETHNICITIES,
} from "@/lib/ad-tool-config";

interface ArchetypeBrief {
  name?: string;
  wardrobe?: string;
  setting?: string;
  hook_delivery_style?: string;
  photoshoot_brief?: string;
  gender?: string;
  age_range?: string;
}

interface Proposal {
  id: string;
  archetype_brief: ArchetypeBrief | null;
  products?: { title?: string } | null;
}

interface LibraryFace {
  id: string;
  url: string;
  status?: string;
  gender?: string;
  age_range?: string;
  health_level?: string;
  ethnicity?: string;
}

const AGE_LABELS: Record<string, string> = {
  under_25: "Under 25",
  "25-34": "25–34",
  "35-44": "35–44",
  "45-54": "45–54",
  "55-64": "55–64",
  "65+": "65+",
};

export default function NewAvatarPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const proposalId = searchParams.get("proposalId");

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [name, setName] = useState("");

  // The four face-generation controls.
  const [gender, setGender] = useState<string>("female");
  const [ageRange, setAgeRange] = useState<string>("35-44");
  const [healthLevel, setHealthLevel] = useState<string>("fit");
  const [ethnicity, setEthnicity] = useState<string>("auto");

  // The persistent face library + selection.
  const [library, setLibrary] = useState<LibraryFace[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  // Manual-upload fallback.
  const [showUpload, setShowUpload] = useState(false);
  const [uploadUrls, setUploadUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLibrary = useCallback(async () => {
    const res = await fetch(`/api/ads/avatars/candidates?workspaceId=${workspace.id}`);
    if (!res.ok) return;
    const json = await res.json();
    setLibrary(json.candidates || []);
  }, [workspace.id]);

  const loadProposal = useCallback(async () => {
    if (!proposalId) return;
    const res = await fetch(`/api/ads/proposals?workspaceId=${workspace.id}`);
    if (!res.ok) return;
    const list: Proposal[] = await res.json();
    const found = list.find((p) => p.id === proposalId);
    if (found) {
      setProposal(found);
      const b = found.archetype_brief;
      if (b?.name) setName(b.name);
      if (b?.gender && (AVATAR_GENDERS as readonly string[]).includes(b.gender)) setGender(b.gender);
      if (b?.age_range && (AVATAR_AGE_RANGES as readonly string[]).includes(b.age_range)) setAgeRange(b.age_range);
    }
  }, [proposalId, workspace.id]);

  useEffect(() => {
    loadProposal();
    loadLibrary();
  }, [loadProposal, loadLibrary]);

  async function generateFaces() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/ads/avatars/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          proposalId: proposalId ?? undefined,
          gender,
          ageRange,
          healthLevel,
          ethnicity,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(
          json.reason === "nsfw"
            ? "A generation was flagged — try different attributes."
            : json.error === "higgsfield_not_connected" || json.reason === "higgsfield_not_connected"
              ? "Connect Higgsfield first (Settings → Integrations)."
              : json.error || "Face generation failed.",
        );
        return;
      }
      // New faces are saved to the library; refresh + auto-select the first.
      const fresh: { id: string }[] = json.candidates || [];
      await loadLibrary();
      if (fresh[0]) setSelectedId(fresh[0].id);
    } catch {
      setError("Face generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  async function deleteFace(id: string) {
    setLibrary((prev) => prev.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
    await fetch(`/api/ads/avatars/candidates?workspaceId=${workspace.id}&id=${id}`, { method: "DELETE" });
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const chosen = Array.from(files).slice(0, 5 - uploadUrls.length);
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
    setUploadUrls((prev) => [...prev, ...uploaded]);
    setSelectedId(null);
    setUploading(false);
  }

  async function createAvatar() {
    const usingUpload = showUpload && uploadUrls.length > 0;
    const selectedFace = library.find((f) => f.id === selectedId);
    const imageUrls = usingUpload ? uploadUrls : selectedFace ? [selectedFace.url] : [];
    if (!name.trim()) {
      setError("Please enter a name.");
      return;
    }
    if (imageUrls.length === 0) {
      setError("Pick a face from your library (or upload a photo) first.");
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
        candidateId: usingUpload ? undefined : selectedId ?? undefined,
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
  const canCreate = !!name.trim() && ((showUpload && uploadUrls.length > 0) || (!showUpload && !!selectedId));

  const selectClass =
    "mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">New avatar</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Generate faces from your buyer demographics, pick one from your library, and name it — no
          photos needed. Every face you generate is saved to your library.
        </p>
      </div>

      {brief && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {brief.name || "Archetype"}{proposal?.products?.title ? ` · ${proposal.products.title}` : ""}
          </h2>
          {brief.photoshoot_brief && (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{brief.photoshoot_brief}</p>
          )}
        </div>
      )}

      {/* Four controls + generate */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">Gender</label>
            <select value={gender} onChange={(e) => setGender(e.target.value)} className={selectClass}>
              {AVATAR_GENDERS.map((g) => (
                <option key={g} value={g}>{g === "female" ? "Female" : "Male"}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">Age</label>
            <select value={ageRange} onChange={(e) => setAgeRange(e.target.value)} className={selectClass}>
              {AVATAR_AGE_RANGES.map((a) => (
                <option key={a} value={a}>{AGE_LABELS[a] || a}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">Health level</label>
            <select value={healthLevel} onChange={(e) => setHealthLevel(e.target.value)} className={selectClass}>
              {AVATAR_HEALTH_LEVELS.map((h) => (
                <option key={h.value} value={h.value}>{h.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">Ethnicity</label>
            <select value={ethnicity} onChange={(e) => setEthnicity(e.target.value)} className={selectClass}>
              {AVATAR_ETHNICITIES.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={generateFaces}
          disabled={generating}
          className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {generating ? "Generating faces…" : "Generate 3 faces"}
        </button>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">≈ 9 Higgsfield credits ($0.56) for 3 faces — saved to your library below.</p>
      </div>

      {/* Library */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            Your avatar library {library.length > 0 && <span className="text-zinc-400">({library.length})</span>}
          </label>
        </div>
        {library.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            No saved faces yet — generate some above. They&apos;ll be saved here so you never have to
            regenerate (or burn credits) for a look you already made.
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4">
            {library.map((face) => (
              <div key={face.id} className="group relative">
                <button
                  onClick={() => setSelectedId(face.id)}
                  className={`block w-full overflow-hidden rounded-lg border-2 transition-colors ${
                    selectedId === face.id ? "border-indigo-500 ring-2 ring-indigo-500/40" : "border-transparent hover:border-zinc-300"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={face.url} alt="" className="aspect-[3/4] w-full object-cover" />
                  {selectedId === face.id && (
                    <span className="absolute left-1 top-1 rounded-full bg-indigo-600 px-1.5 text-xs text-white">✓</span>
                  )}
                  {face.status === "used" && (
                    <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white">used</span>
                  )}
                </button>
                <button
                  onClick={() => deleteFace(face.id)}
                  title="Delete this face"
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Name */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Morning-routine Mia"
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
      </div>

      {/* Optional manual upload fallback */}
      <div className="text-sm">
        <button
          onClick={() => setShowUpload((v) => !v)}
          className="text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          {showUpload ? "Hide" : "Advanced: upload your own photos instead"}
        </button>
        {showUpload && (
          <div className="mt-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={uploading || uploadUrls.length >= 5}
              onChange={(e) => handleFiles(e.target.files)}
              className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 dark:text-zinc-300 dark:file:bg-zinc-800 dark:file:text-zinc-200"
            />
            {uploadUrls.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {uploadUrls.map((url) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={url} src={url} alt="" className="h-16 w-16 rounded-md object-cover" />
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Uploaded photos take priority over a selected library face.</p>
          </div>
        )}
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Creating the avatar costs 40 Higgsfield credits (≈ $2.50) — charged once when you click Create.
      </p>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={createAvatar}
          disabled={creating || !canCreate}
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
