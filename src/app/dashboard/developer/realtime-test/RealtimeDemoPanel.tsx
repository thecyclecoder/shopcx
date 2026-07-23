"use client";

/**
 * realtime-demo — a live Supabase Realtime (Postgres Changes) verification panel.
 *
 * Subscribes to `public.realtime_demo` over a WebSocket and renders every row + a running event log.
 * NO polling: the browser opens ONE connection, authenticates once, and the server pushes a row event
 * only when the table actually changes (INSERT/UPDATE/DELETE). An idle panel costs nothing; a change
 * appears within a few hundred ms.
 *
 * To verify: open this page, then have a service-role write touch a realtime_demo row
 * (`scripts/_bump-realtime-demo.ts`). The row's tick/note should update here with no refresh, and the
 * event log should append the change.
 */

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

type DemoRow = {
  id: string;
  workspace_id: string;
  label: string;
  tick: number;
  note: string | null;
  updated_at: string;
};

type LogEntry = { at: string; kind: string; detail: string };

// Connection lifecycle the Realtime channel reports back through .subscribe().
type ConnState = "connecting" | "live" | "error" | "closed";

export default function RealtimeDemoPanel() {
  const [rows, setRows] = useState<DemoRow[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    // Initial snapshot via the server route (session-authed) — the app reads data through /api/*,
    // not a browser-side PostgREST call; the browser client here is Realtime-only. After this ONE
    // fetch we never poll again — updates arrive over the subscription below.
    void fetch("/api/developer/realtime-demo")
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((d: { rows?: DemoRow[] }) => {
        if (!cancelled && d.rows) setRows(d.rows);
      })
      .catch(() => {
        /* transient — the subscription still delivers live changes */
      });

    const pushLog = (kind: string, detail: string) =>
      setLog((prev) => [{ at: new Date().toLocaleTimeString(), kind, detail }, ...prev].slice(0, 30));

    // Realtime BROADCAST (not Postgres Changes). A DB trigger (realtime_demo_broadcast_trg) calls
    // realtime.broadcast_changes() to push each row change to the PRIVATE 'realtime_demo' topic; we
    // subscribe to that topic. This deliberately avoids Postgres Changes, whose per-row RLS engine
    // (Walrus) silently drops INSERT/UPDATE events on our table (a known open Supabase bug — only
    // DELETE, which skips RLS, leaked through). Broadcast authorization is channel-level via an
    // RLS policy on realtime.messages, gated by topic — much simpler and it actually works.
    //
    // A private channel requires the socket to carry the user's JWT, so setAuth runs BEFORE subscribe.
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session?.access_token) await supabase.realtime.setAuth(data.session.access_token);

      channel = supabase
        .channel("realtime_demo", { config: { private: true } })
        .on("broadcast", { event: "db_change" }, (msg) => {
          // broadcast_changes payload: { operation, record (new), old_record (old), table, schema }
          const p = (msg.payload ?? {}) as {
            operation?: string;
            record?: DemoRow | null;
            old_record?: DemoRow | null;
          };
          if (p.operation === "INSERT" || p.operation === "UPDATE") {
            const nr = p.record;
            if (!nr) return;
            setRows((prev) =>
              prev.some((r) => r.id === nr.id)
                ? prev.map((r) => (r.id === nr.id ? nr : r))
                : [nr, ...prev],
            );
            pushLog(p.operation, `${nr.label} tick=${nr.tick} · ${nr.note ?? ""}`);
          } else if (p.operation === "DELETE") {
            const goneId = p.old_record?.id;
            if (goneId) setRows((prev) => prev.filter((r) => r.id !== goneId));
            pushLog("DELETE", goneId ?? "(row)");
          }
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") setConn("live");
          else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setConn("error");
          else if (status === "CLOSED") setConn("closed");
        });

      channelRef.current = channel;
    })();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, []);

  const dot =
    conn === "live" ? "bg-green-500" : conn === "connecting" ? "bg-amber-400" : "bg-red-500";
  const connLabel =
    conn === "live" ? "Live — subscribed (no polling)" : conn === "connecting" ? "Connecting…" : conn === "error" ? "Connection error" : "Closed";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <span className="relative flex h-2.5 w-2.5">
          {conn === "live" && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
          )}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dot}`} />
        </span>
        <span className="text-gray-700 dark:text-gray-300">{connLabel}</span>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-500 dark:text-gray-400">
          Rows (pushed live from Postgres)
        </h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">label</th>
                <th className="px-3 py-2">tick</th>
                <th className="px-3 py-2">note</th>
                <th className="px-3 py-2">updated_at</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="px-3 py-3 text-gray-400" colSpan={4}>
                    No rows yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-3 py-2 font-medium">{r.label}</td>
                    <td className="px-3 py-2 tabular-nums">{r.tick}</td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{r.note}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-400">
                      {new Date(r.updated_at).toLocaleTimeString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-500 dark:text-gray-400">Event log</h2>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 font-mono text-xs dark:border-gray-800">
          {log.length === 0 ? (
            <p className="px-3 py-3 text-gray-400">
              Waiting for a change… run a service-role write against a realtime_demo row.
            </p>
          ) : (
            log.map((e, i) => (
              <div key={i} className="flex gap-3 border-t border-gray-100 px-3 py-1.5 first:border-t-0 dark:border-gray-800">
                <span className="text-gray-400">{e.at}</span>
                <span className="font-semibold">{e.kind}</span>
                <span className="text-gray-600 dark:text-gray-300">{e.detail}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
