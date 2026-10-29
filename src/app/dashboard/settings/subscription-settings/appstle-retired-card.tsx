"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Owner-only on/off for the `appstle_retired` switch. On = Appstle is never called again; reviving a
 * sub that never migrated rebuilds it on ShopCX from our own records. Hidden for non-owners (403).
 */
export default function AppstleRetiredCard({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<{ retired: boolean; active_appstle_subs: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/appstle-retired`);
    return res.ok ? ((await res.json()) as { retired: boolean; active_appstle_subs: number }) : null;
  }, [workspaceId]);
  const load = useCallback(async () => { setState(await fetchState()); }, [fetchState]);

  useEffect(() => {
    let live = true;
    fetchState().then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [fetchState]);

  if (!state) return null;

  const toggle = async () => {
    const next = !state.retired;
    const warn = next && state.active_appstle_subs > 0
      ? `\n\n${state.active_appstle_subs} active subscription(s) are still billed by Appstle. Touching one while retired could bill it twice.`
      : "";
    const msg = next
      ? `Retire Appstle? ShopCX will never call Appstle again, and reviving a never-migrated subscription will rebuild it on ShopCX.${warn}`
      : "Restore Appstle? ShopCX will call Appstle again for Appstle-billed subscriptions. Only useful while Appstle is still installed.";
    if (!window.confirm(msg)) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/appstle-retired`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retired: next }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Failed");
      return;
    }
    await load();
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Appstle</h2>
      <p className="mb-3 text-xs text-zinc-500">
        {state.retired
          ? "Retired. ShopCX never calls Appstle. Reviving a subscription that never migrated rebuilds it on ShopCX."
          : "Live. ShopCX still calls Appstle for Appstle-billed subscriptions. Retire it before you uninstall the Appstle app."}
      </p>
      <p className="mb-3 text-xs text-zinc-400">Active subscriptions still billed by Appstle: {state.active_appstle_subs}</p>
      <div className="flex items-center gap-3">
        <button onClick={toggle} disabled={busy}
          className={state.retired
            ? "rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300"
            : "rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"}>
          {busy ? "Saving..." : state.retired ? "Restore Appstle" : "Retire Appstle"}
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
