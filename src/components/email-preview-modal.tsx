"use client";

interface EmailPreviewModalProps {
  html: string;
  subject: string;
  to?: string;
  sentAt?: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function EmailPreviewModal({ html, subject, to, sentAt, isOpen, onClose }: EmailPreviewModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-700">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{subject}</p>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-zinc-400">
              {to && <span>To: {to}</span>}
              {sentAt && <span>{new Date(sentAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-3 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Email content in iframe for CSS isolation */}
        <div className="flex-1 overflow-auto bg-white p-1">
          <iframe
            srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:16px;color:#1a1a1a;font-size:14px;line-height:1.6;}a{color:#4f46e5;}img{max-width:100%;}</style></head><body>${html}</body></html>`}
            className="h-full min-h-[300px] w-full border-0"
            sandbox="allow-same-origin"
            title="Email preview"
          />
        </div>
      </div>
    </div>
  );
}
