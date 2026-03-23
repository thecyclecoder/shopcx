"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";

export default function NewWorkspacePage() {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setLoading(true);
    setError("");

    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Failed to create workspace");
      setLoading(false);
      return;
    }

    router.push("/dashboard");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-md space-y-8 px-6">
        <div className="flex flex-col items-center gap-3">
          <Image src="/logo.svg" alt="ShopCX.AI" width={48} height={48} priority />
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            Create your workspace
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Set up your team&apos;s workspace to get started
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Workspace name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Superfoods Company"
              required
              className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
            />
          </div>

          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create workspace"}
          </button>
        </form>
      </div>
    </div>
  );
}
