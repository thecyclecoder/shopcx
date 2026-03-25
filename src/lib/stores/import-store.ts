import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ImportJobStatus = "pending" | "uploading" | "splitting" | "processing" | "finalizing" | "completed" | "failed";

export interface ImportJob {
  id: string;
  workspace_id: string;
  type: string;
  status: ImportJobStatus;
  file_path: string;
  total_records: number;
  processed_records: number;
  failed_records: number;
  total_chunks: number;
  completed_chunks: number;
  finalize_total: number;
  finalize_completed: number;
  error: string | null;
  failed_chunk_index: number | null;
  started_at: string;
  completed_at: string | null;
}

interface ImportStore {
  activeJobId: string | null;
  workspaceId: string | null;
  job: ImportJob | null;
  dismissed: boolean;
  _pollInterval: ReturnType<typeof setInterval> | null;

  startJob: (workspaceId: string, jobId: string) => void;
  startPolling: () => void;
  stopPolling: () => void;
  dismiss: () => void;
  clear: () => void;
}

export const useImportStore = create<ImportStore>()(
  persist(
    (set, get) => ({
      activeJobId: null,
      workspaceId: null,
      job: null,
      dismissed: false,
      _pollInterval: null,

      startJob: (workspaceId: string, jobId: string) => {
        get().stopPolling();
        set({
          activeJobId: jobId,
          workspaceId,
          job: null,
          dismissed: false,
        });
        get().startPolling();
      },

      startPolling: () => {
        const { activeJobId, workspaceId, _pollInterval } = get();
        if (!activeJobId || !workspaceId || _pollInterval) return;

        const poll = async () => {
          const { activeJobId: jid, workspaceId: wid } = get();
          if (!jid || !wid) return;

          try {
            const res = await fetch(`/api/workspaces/${wid}/import/${jid}`);
            if (!res.ok) return;
            const data = await res.json();
            set({ job: data });

            if (data.status === "completed" || data.status === "failed") {
              get().stopPolling();
            }
          } catch {
            // Network error, keep polling
          }
        };

        // Poll immediately, then every 3s
        poll();
        const interval = setInterval(poll, 3000);
        set({ _pollInterval: interval });
      },

      stopPolling: () => {
        const { _pollInterval } = get();
        if (_pollInterval) {
          clearInterval(_pollInterval);
          set({ _pollInterval: null });
        }
      },

      dismiss: () => {
        get().stopPolling();
        set({
          activeJobId: null,
          workspaceId: null,
          job: null,
          dismissed: true,
          _pollInterval: null,
        });
      },

      clear: () => {
        get().stopPolling();
        set({
          activeJobId: null,
          workspaceId: null,
          job: null,
          dismissed: false,
          _pollInterval: null,
        });
      },
    }),
    {
      name: "shopcx-import",
      partialize: (state) => ({
        activeJobId: state.activeJobId,
        workspaceId: state.workspaceId,
      }),
    }
  )
);
