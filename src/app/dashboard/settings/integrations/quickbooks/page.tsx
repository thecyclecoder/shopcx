"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

interface QboStatus {
  connected: boolean;
  realmId: string | null;
  environment: string | null;
  connectedAt: string | null;
  configured: boolean;
}

const CALLBACK_STATUS: Record<string, { ok: boolean; msg: string }> = {
  connected: { ok: true, msg: "QuickBooks connected." },
  denied: { ok: false, msg: "Authorization was cancelled." },
  csrf: { ok: false, msg: "Security check failed (CSRF). Try again." },
  bad_state: { ok: false, msg: "Invalid OAuth state. Try again." },
  missing_params: { ok: false, msg: "Intuit did not return the expected parameters." },
  unauthorized: { ok: false, msg: "You must be signed in to connect." },
  forbidden: { ok: false, msg: "Only an owner/admin can connect QuickBooks." },
  exchange_failed: { ok: false, msg: "Token exchange with Intuit failed. Check the app config + redirect URI." },
};

export default function QuickBooksSettingsPage() {
  const search = useSearchParams();
  const [status, setStatus] = useState<QboStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/qbo/status")
      .then((r) => r.json())
      .then((d) => setStatus(d))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const callbackResult = (() => {
    const q = search.get("qbo");
    return q ? CALLBACK_STATUS[q] ?? { ok: false, msg: `Unknown result: ${q}` } : null;
  })();

  const disconnect = async () => {
    if (!confirm("Disconnect QuickBooks? This revokes the token; you'll need to reconnect to resume P&L syncing.")) return;
    setBusy(true);
    await fetch("/api/qbo/disconnect", { method: "POST" });
    setBusy(false);
    load();
  };

  const redirectUri = `${typeof window !== "undefined" ? window.location.origin : "https://shopcx.ai"}/api/qbo/callback`;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
      <Link href="/dashboard/settings/integrations" className="mb-4 inline-block text-sm text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
        &larr; Back to Integrations
      </Link>
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-600/10">
          <svg className="h-5 w-5 text-teal-600 dark:text-teal-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 7h6m-6 4h6m-6 4h4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">QuickBooks Online</h1>
      </div>

      <p className="mb-6 text-sm text-zinc-500">
        Connect QuickBooks so shopcx pulls the monthly Profit &amp; Loss into the CFO scoreboard (revenue + booked/adjusted profit).
        This gives shopcx its <strong>own</strong> token — independent of any other app on the same QuickBooks company.
      </p>

      {callbackResult && (
        <div className={`mb-4 rounded-lg border p-3 text-sm ${callbackResult.ok ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900/40 dark:bg-green-900/20 dark:text-green-300" : "border-red-200 bg-red-50 text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"}`}>
          {callbackResult.msg}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-400">Loading…</div>
      ) : status?.connected ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Connected</span>
          </div>
          <dl className="space-y-1 text-sm text-zinc-500">
            <div className="flex gap-2"><dt className="w-32 shrink-0">Company (realm)</dt><dd className="font-mono text-zinc-700 dark:text-zinc-300">{status.realmId}</dd></div>
            <div className="flex gap-2"><dt className="w-32 shrink-0">Environment</dt><dd className="text-zinc-700 dark:text-zinc-300">{status.environment}</dd></div>
            <div className="flex gap-2"><dt className="w-32 shrink-0">Connected</dt><dd className="text-zinc-700 dark:text-zinc-300">{status.connectedAt ? new Date(status.connectedAt).toLocaleString() : "—"}</dd></div>
          </dl>
          <button onClick={disconnect} disabled={busy} className="mt-4 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/40 dark:text-red-300 dark:hover:bg-red-900/20">
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          {status && !status.configured && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
              QuickBooks app credentials aren&apos;t configured yet (<code>QUICKBOOKS_CLIENT_ID</code> / <code>QUICKBOOKS_CLIENT_SECRET</code>).
            </div>
          )}
          <a
            href="/api/qbo/connect"
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white ${status?.configured ? "bg-teal-600 hover:bg-teal-500" : "pointer-events-none bg-zinc-300 dark:bg-zinc-700"}`}
          >
            Connect QuickBooks
          </a>
          <p className="mt-4 text-xs text-zinc-500">
            One-time setup: in the Intuit developer portal, add this exact <strong>Redirect URI</strong> to the app&apos;s OAuth settings —
          </p>
          <code className="mt-1 block break-all rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{redirectUri}</code>
        </div>
      )}
    </div>
  );
}
