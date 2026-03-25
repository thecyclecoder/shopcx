"use client";

import { useEffect } from "react";
import { useImportStore, type ImportJobStatus } from "@/lib/stores/import-store";

const STEPS: { key: ImportJobStatus; label: string }[] = [
  { key: "uploading", label: "Uploading" },
  { key: "splitting", label: "Splitting" },
  { key: "processing", label: "Processing" },
  { key: "finalizing", label: "Updating" },
  { key: "completed", label: "Complete" },
];

function stepIndex(status: ImportJobStatus): number {
  const idx = STEPS.findIndex(s => s.key === status);
  return idx === -1 ? 0 : idx;
}

function overallProgress(job: { status: ImportJobStatus; total_records: number; processed_records: number; total_chunks: number; completed_chunks: number; finalize_total: number; finalize_completed: number }): number {
  switch (job.status) {
    case "pending":
    case "uploading":
      return 5;
    case "splitting":
      return 10;
    case "processing": {
      if (job.total_chunks === 0) return 15;
      const pct = (job.completed_chunks / job.total_chunks) * 70;
      return Math.round(15 + pct);
    }
    case "finalizing": {
      if (job.finalize_total === 0) return 88;
      const pct = (job.finalize_completed / job.finalize_total) * 10;
      return Math.round(88 + pct);
    }
    case "completed":
      return 100;
    case "failed":
      return 0;
    default:
      return 0;
  }
}

export default function ImportProgressBar() {
  const { activeJobId, job, dismissed, startPolling, dismiss } = useImportStore();

  // Auto-resume polling on mount if there's an active job
  useEffect(() => {
    if (activeJobId && (!job || (job.status !== "completed" && job.status !== "failed"))) {
      startPolling();
    }
  }, [activeJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!activeJobId || !job || dismissed) return null;
  if (job.status === "pending") return null;

  const current = stepIndex(job.status);
  const pct = overallProgress(job);
  const isFailed = job.status === "failed";
  const isDone = job.status === "completed";

  return (
    <div className={`border-b px-4 py-2 ${
      isFailed
        ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950"
        : isDone
          ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950"
          : "border-indigo-200 bg-indigo-50 dark:border-indigo-900 dark:bg-indigo-950"
    }`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0">
            Import
          </span>

          {/* Stepper */}
          <div className="hidden sm:flex items-center gap-1">
            {STEPS.map((step, i) => {
              const isActive = i === current && !isFailed;
              const isComplete = i < current || isDone;
              return (
                <div key={step.key} className="flex items-center gap-1">
                  {i > 0 && (
                    <div className={`h-px w-4 ${
                      isComplete ? "bg-indigo-400" : "bg-zinc-300 dark:bg-zinc-700"
                    }`} />
                  )}
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    isActive
                      ? "bg-indigo-100 text-indigo-700 font-medium dark:bg-indigo-900 dark:text-indigo-300"
                      : isComplete
                        ? "text-indigo-500 dark:text-indigo-400"
                        : "text-zinc-400 dark:text-zinc-600"
                  }`}>
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Mobile: just show current step */}
          <span className="sm:hidden text-xs text-zinc-600 dark:text-zinc-400">
            {isFailed ? "Failed" : isDone ? "Complete" : STEPS[current]?.label || "..."}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Progress text */}
          {!isFailed && !isDone && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
              {job.processed_records.toLocaleString()}
              {job.total_records > 0 ? ` / ${job.total_records.toLocaleString()}` : ""}
            </span>
          )}

          {isFailed && (
            <span className="text-xs text-red-600 dark:text-red-400">
              {job.error || "Import failed"}
            </span>
          )}

          {isDone && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">
              {job.processed_records.toLocaleString()} imported
            </span>
          )}

          {/* Dismiss button */}
          {(isDone || isFailed) && (
            <button
              onClick={dismiss}
              className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>

      {/* Thin progress bar */}
      {!isFailed && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              isDone ? "bg-emerald-500" : "bg-indigo-500"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
