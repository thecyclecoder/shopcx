"use client";

import { useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { createClient } from "@/lib/supabase/client";

export default function ImportPage() {
  const workspace = useWorkspace();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ imported: number; skipped: number; total_subscriptions: number } | null>(null);

  if (!["owner", "admin"].includes(workspace.role)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setMessage("");
    setResult(null);

    try {
      const supabase = createClient();
      const fileName = `${workspace.id}/${Date.now()}-${file.name}`;

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from("imports")
        .upload(fileName, file);

      if (uploadError) {
        setMessage(`Upload failed: ${uploadError.message}`);
        setUploading(false);
        return;
      }

      setUploading(false);
      setProcessing(true);
      setMessage("Processing CSV...");

      // Trigger processing
      const res = await fetch(`/api/workspaces/${workspace.id}/import/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: fileName }),
      });

      const data = await res.json();

      if (res.ok) {
        setResult(data);
        setMessage(`Import complete! ${data.imported} subscriptions imported, ${data.skipped} skipped.`);
      } else {
        setMessage(data.error || "Processing failed");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setProcessing(false);
    }
  };

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Import Data</h1>
      <p className="mt-2 text-sm text-zinc-500">Upload CSV files to import data into your workspace.</p>

      <div className="mt-8 max-w-xl">
        {/* Subscription Import */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Appstle Subscriptions</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Upload a subscription export CSV from Appstle. This will create or update subscription records and link them to existing customers by email.
          </p>

          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-xs font-medium text-zinc-500">CSV File</label>
              <input
                type="file"
                accept=".csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="mt-1 block w-full text-sm text-zinc-500 file:mr-4 file:rounded-md file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-indigo-600 hover:file:bg-indigo-100 dark:file:bg-indigo-950 dark:file:text-indigo-400"
              />
              {file && (
                <p className="mt-1 text-xs text-zinc-400">
                  {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
                </p>
              )}
            </div>

            <button
              onClick={handleUpload}
              disabled={!file || uploading || processing}
              className="cursor-pointer rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploading ? "Uploading..." : processing ? "Processing..." : "Upload & Import"}
            </button>

            {message && (
              <div className={`rounded-md p-3 text-sm ${
                result
                  ? "border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400"
                  : "border border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-400"
              }`}>
                {message}
                {result && (
                  <div className="mt-2 text-xs">
                    <p>Total subscriptions: {result.total_subscriptions.toLocaleString()}</p>
                    <p>Imported: {result.imported.toLocaleString()}</p>
                    <p>Skipped: {result.skipped.toLocaleString()}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
