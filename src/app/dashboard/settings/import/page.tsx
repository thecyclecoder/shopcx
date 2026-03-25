"use client";

import { useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { createClient } from "@/lib/supabase/client";
import { useImportStore, type ImportJobStatus } from "@/lib/stores/import-store";

const STEPS: { key: ImportJobStatus; label: string }[] = [
  { key: "uploading", label: "Uploading" },
  { key: "splitting", label: "Splitting" },
  { key: "processing", label: "Processing" },
  { key: "finalizing", label: "Updating Customers" },
  { key: "completed", label: "Complete" },
];

function stepIndex(status: ImportJobStatus): number {
  const idx = STEPS.findIndex(s => s.key === status);
  return idx === -1 ? 0 : idx;
}

export default function ImportPage() {
  const workspace = useWorkspace();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");

  const { activeJobId, job, startJob } = useImportStore();

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

    try {
      const supabase = createClient();
      const fileName = `${workspace.id}/${Date.now()}-${file.name}`;

      setMessage("Uploading file...");
      const { error: uploadError } = await supabase.storage.from("imports").upload(fileName, file);
      if (uploadError) { setMessage(`Upload failed: ${uploadError.message}`); setUploading(false); return; }

      setMessage("Starting import...");

      const res = await fetch(`/api/workspaces/${workspace.id}/import/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: fileName }),
      });
      const data = await res.json();

      if (res.ok && data.job_id) {
        startJob(workspace.id, data.job_id);
        setMessage("");
        setFile(null);
      } else {
        setMessage(data.error || "Failed to start import");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed");
    } finally {
      setUploading(false);
    }
  };

  const handleResume = async () => {
    if (!activeJobId || !job || job.status !== "failed") return;
    setMessage("Resuming...");
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/import/${activeJobId}`, { method: "POST" });
      if (res.ok) {
        startJob(workspace.id, activeJobId);
        setMessage("");
      } else {
        const data = await res.json();
        setMessage(data.error || "Resume failed");
      }
    } catch {
      setMessage("Resume failed");
    }
  };

  const isProcessing = job && !["completed", "failed"].includes(job.status) && job.status !== "pending";
  const isFailed = job?.status === "failed";
  const isDone = job?.status === "completed";
  const currentStep = job ? stepIndex(job.status) : -1;

  const pct = job
    ? job.total_records > 0
      ? Math.min(95, Math.round((job.processed_records / job.total_records) * 95))
      : 0
    : 0;

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
              <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] || null)} disabled={!!isProcessing}
                className="mt-1 block w-full text-sm text-zinc-500 file:mr-4 file:rounded-md file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-indigo-600 hover:file:bg-indigo-100 disabled:opacity-50 dark:file:bg-indigo-950 dark:file:text-indigo-400" />
              {file && <p className="mt-1 text-xs text-zinc-400">{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)</p>}
            </div>

            <div className="flex gap-2">
              <button onClick={handleUpload} disabled={!file || uploading || !!isProcessing}
                className="cursor-pointer rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
                {uploading ? "Uploading..." : isProcessing ? "Processing..." : "Upload & Import"}
              </button>

              {isFailed && (
                <button onClick={handleResume}
                  className="cursor-pointer rounded-md border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-600 transition-colors hover:bg-indigo-50 dark:border-indigo-700 dark:bg-zinc-900 dark:text-indigo-400 dark:hover:bg-zinc-800">
                  Resume
                </button>
              )}
            </div>

            {/* Stepper */}
            {(isProcessing || isDone || isFailed) && job && (
              <div className="mt-2">
                <div className="flex items-center gap-1">
                  {STEPS.map((step, i) => {
                    const isActive = i === currentStep && !isFailed;
                    const isComplete = i < currentStep || isDone;
                    return (
                      <div key={step.key} className="flex items-center gap-1">
                        {i > 0 && (
                          <div className={`h-px w-6 ${
                            isComplete ? "bg-indigo-400" : "bg-zinc-300 dark:bg-zinc-700"
                          }`} />
                        )}
                        <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                          isActive
                            ? "bg-indigo-100 text-indigo-700 font-medium dark:bg-indigo-900 dark:text-indigo-300"
                            : isComplete
                              ? "text-indigo-500 dark:text-indigo-400"
                              : "text-zinc-400 dark:text-zinc-600"
                        }`}>
                          {isComplete && !isActive && (
                            <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          )}
                          {step.label}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Progress bar */}
            {isProcessing && job && (
              <div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {job.processed_records.toLocaleString()}{job.total_records > 0 ? ` / ${job.total_records.toLocaleString()}` : ""}
                    {job.status === "processing" && job.total_chunks > 0 && (
                      <span className="ml-2 text-xs text-zinc-400">
                        (chunk {job.completed_chunks}/{job.total_chunks})
                      </span>
                    )}
                    {job.status === "finalizing" && job.finalize_total > 0 && (
                      <span className="ml-2 text-xs text-zinc-400">
                        (batch {job.finalize_completed}/{job.finalize_total})
                      </span>
                    )}
                  </span>
                  {job.total_records > 0 && <span className="text-xs text-zinc-400">{pct}%</span>}
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className={`h-full rounded-full transition-all duration-700 ${
                    job.status === "pending" || job.status === "uploading" || job.status === "splitting"
                      ? "animate-pulse bg-indigo-300"
                      : "bg-indigo-500"
                  }`}
                    style={{ width: job.status === "uploading" || job.status === "splitting" ? "100%" : `${pct}%` }} />
                </div>
              </div>
            )}

            {/* Success message */}
            {isDone && job && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400">
                Import complete! {job.processed_records.toLocaleString()} subscriptions imported.
              </div>
            )}

            {/* Error message */}
            {isFailed && job && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
                {job.error || "Import failed"}
                {job.failed_chunk_index != null && (
                  <span className="ml-1 text-xs">(failed at chunk {job.failed_chunk_index})</span>
                )}
              </div>
            )}

            {/* Upload message */}
            {message && !isProcessing && !isDone && !isFailed && (
              <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-400">
                {message}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
