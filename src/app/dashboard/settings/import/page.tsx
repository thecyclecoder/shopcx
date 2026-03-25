"use client";

import { useState, useRef, useEffect } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { createClient } from "@/lib/supabase/client";

export default function ImportPage() {
  const workspace = useWorkspace();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState({ synced: 0, total: 0 });
  const [message, setMessage] = useState("");
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  if (!["owner", "admin"].includes(workspace.role)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }

  const startPolling = (jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/workspaces/${workspace.id}/sync?job_id=${jobId}`);
      const job = await res.json();
      if (job) {
        setJobStatus(job.status);
        setProgress({ synced: job.synced_customers || 0, total: job.total_customers || 0 });
        if (job.status === "completed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setMessage(`Import complete! ${(job.synced_customers || 0).toLocaleString()} subscriptions imported.`);
        } else if (job.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setMessage(job.error || "Import failed");
        }
      }
    }, 3000);
  };

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setMessage("");
    setJobStatus(null);
    setProgress({ synced: 0, total: 0 });

    try {
      const supabase = createClient();
      const fileName = `${workspace.id}/${Date.now()}-${file.name}`;

      setMessage("Uploading file...");
      const { error: uploadError } = await supabase.storage.from("imports").upload(fileName, file);
      if (uploadError) { setMessage(`Upload failed: ${uploadError.message}`); setUploading(false); return; }

      setUploading(false);
      setMessage("Starting import...");

      const res = await fetch(`/api/workspaces/${workspace.id}/import/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: fileName }),
      });
      const data = await res.json();

      if (res.ok && data.job_id) {
        setJobStatus("pending");
        setMessage("Processing subscriptions...");
        startPolling(data.job_id);
      } else {
        setMessage(data.error || "Failed to start import");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed");
    } finally {
      setUploading(false);
    }
  };

  const isProcessing = jobStatus === "pending" || jobStatus === "running";
  const pct = progress.total > 0 ? Math.min(95, Math.round((progress.synced / progress.total) * 95)) : 0;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Import Data</h1>
      <p className="mt-2 text-sm text-zinc-500">Upload CSV files to import data into your workspace.</p>

      <div className="mt-8 max-w-xl">
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Appstle Subscriptions</h2>
          <p className="mt-1 text-xs text-zinc-500">Upload a subscription export CSV from Appstle.</p>

          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-xs font-medium text-zinc-500">CSV File</label>
              <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] || null)} disabled={isProcessing}
                className="mt-1 block w-full text-sm text-zinc-500 file:mr-4 file:rounded-md file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-indigo-600 hover:file:bg-indigo-100 disabled:opacity-50 dark:file:bg-indigo-950 dark:file:text-indigo-400" />
              {file && <p className="mt-1 text-xs text-zinc-400">{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)</p>}
            </div>

            <button onClick={handleUpload} disabled={!file || uploading || isProcessing}
              className="cursor-pointer rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
              {uploading ? "Uploading..." : isProcessing ? "Processing..." : "Upload & Import"}
            </button>

            {isProcessing && (
              <div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-700 dark:text-zinc-300">
                    Importing: {progress.synced.toLocaleString()}{progress.total > 0 ? ` / ${progress.total.toLocaleString()}` : ""}
                  </span>
                  {progress.total > 0 && <span className="text-xs text-zinc-400">{pct}%</span>}
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className={`h-full rounded-full transition-all duration-700 ${jobStatus === "pending" ? "animate-pulse bg-indigo-300" : "bg-indigo-500"}`}
                    style={{ width: jobStatus === "pending" ? "100%" : `${pct}%` }} />
                </div>
              </div>
            )}

            {message && !isProcessing && (
              <div className={`rounded-md p-3 text-sm ${
                jobStatus === "completed" ? "border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400"
                : jobStatus === "failed" ? "border border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
                : "border border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-400"
              }`}>{message}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
