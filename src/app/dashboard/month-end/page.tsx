"use client";

/**
 * Month-end close — the operator surface for the QuickBooks close.
 *
 * Deliberately shaped so the SAFE action is the easy one: "Run dry run" is the primary button
 * and writes nothing; posting is secondary, disabled until the guard passes, and asks for typed
 * confirmation. The InventoryAdjustment and the three SalesReceipts cannot be un-posted.
 */
import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface BlockingIssue { code: string; detail: string }
interface StepResult { step: number; name: string; status: string; message: string }
interface RunResponse {
  month: string;
  mode: string;
  refused: string | null;
  guard: { passed: boolean; blocking: BlockingIssue[]; warnings: string[] };
  steps: StepResult[];
  summary: {
    je_lines: number; je_debits: number; je_credits: number;
    adjustment_lines: number;
    receipt_units: { amazon: number; shopify: number; internal: number };
    shopify_orders: number;
  };
  warnings: string[];
}
interface StatusResponse {
  eligibility: { allowed: boolean; reason?: string; provenAt?: string };
  latest_dry_run: Record<string, unknown> | null;
  closing: Record<string, unknown> | null;
}

const money = (n: number | null | undefined) =>
  n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Default to the most recently ELAPSED month — the close never runs mid-month. */
function defaultMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export default function MonthEndPage() {
  const workspace = useWorkspace();
  const [month, setMonth] = useState(defaultMonth());
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [btFees, setBtFees] = useState("");
  const [btNote, setBtNote] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/qb/month-end-closing?month=${month}&workspace_id=${workspace.id}`);
      setStatus(await r.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [month, workspace.id]);

  useEffect(() => { setRun(null); setConfirm(""); setBtNote(null); loadStatus(); }, [loadStatus]);

  async function doRun(post: boolean) {
    setBusy(post ? "post" : "dry"); setError(null); setBtNote(null);
    try {
      const r = await fetch("/api/qb/month-end-closing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, workspace_id: workspace.id, ...(post ? { post: true } : {}) }),
      });
      const data = await r.json();
      if (!r.ok && !data.guard) throw new Error(data.error ?? `HTTP ${r.status}`);
      setRun(data);
      await loadStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null); setConfirm("");
    }
  }

  async function saveBraintreeFees() {
    setBusy("bt"); setError(null); setBtNote(null);
    try {
      const r = await fetch("/api/qb/month-end-closing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, workspace_id: workspace.id, processor: "braintree", processing_fees: Number(btFees) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setBtNote(d.note ?? "Saved.");
      await loadStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const closed = !!status?.closing && ["completed", "completed_with_errors"].includes(String(status.closing.status));
  const guard = run?.guard ?? null;
  const canPost = !!status?.eligibility.allowed && (guard ? guard.passed : true) && !closed;

  return (
    <div className="p-6 max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Month-end close</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Computes the 5 QuickBooks artifacts. A dry run writes nothing — posting is irreversible for
          the inventory adjustment and the three sales receipts.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-zinc-500 mb-1">Closing month</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-2 bg-white dark:bg-zinc-900 dark:border-zinc-700" />
        </label>
        <button onClick={() => doRun(false)} disabled={!!busy}
          className="px-4 py-2 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 disabled:opacity-50">
          {busy === "dry" ? "Running…" : "Run dry run"}
        </button>
        {status && (
          <span className={`text-sm ${closed ? "text-amber-600" : status.eligibility.allowed ? "text-emerald-600" : "text-zinc-500"}`}>
            {closed ? `Already closed (${String(status.closing?.status)})`
              : status.eligibility.allowed ? `Eligible to post — proven ${String(status.eligibility.provenAt).slice(0, 16)}`
              : status.eligibility.reason}
          </span>
        )}
      </div>

      {error && <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">{error}</div>}

      {run?.refused && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
          <strong>Refused.</strong> {run.refused}
        </div>
      )}

      {run?.warnings?.map((w) => (
        <div key={w} className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">⚠️ {w}</div>
      ))}

      {guard && (
        <div className={`rounded-xl border p-4 ${guard.passed ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20" : "border-red-300 bg-red-50 dark:bg-red-950/20"}`}>
          <div className="font-medium mb-2">{guard.passed ? "✓ Guard passes — eligible to post" : `✗ Blocked — ${guard.blocking.length} issue(s)`}</div>
          <ul className="space-y-1 text-sm">
            {guard.blocking.map((b) => (
              <li key={b.code}><code className="text-xs bg-black/5 dark:bg-white/10 px-1 rounded">{b.code}</code> {b.detail}</li>
            ))}
            {guard.warnings.map((w) => <li key={w} className="text-zinc-600 dark:text-zinc-400">• {w}</li>)}
          </ul>
        </div>
      )}

      {run && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Journal entry", value: money(run.summary.je_debits), sub: `${run.summary.je_lines} lines · ${Math.abs(run.summary.je_debits - run.summary.je_credits) <= 0.01 ? "balanced" : "OUT OF BALANCE"}` },
            { label: "Adjustment lines", value: String(run.summary.adjustment_lines), sub: "inventory true-up" },
            { label: "Receipt units", value: String(run.summary.receipt_units.amazon + run.summary.receipt_units.shopify + run.summary.receipt_units.internal), sub: `AMZ ${run.summary.receipt_units.amazon} · SHOP ${run.summary.receipt_units.shopify} · INT ${run.summary.receipt_units.internal}` },
            { label: "Shopify orders", value: String(run.summary.shopify_orders), sub: "JE revenue basis" },
          ].map((c) => (
            <div key={c.label} className="rounded-xl border dark:border-zinc-700 p-3">
              <div className="text-xs text-zinc-500">{c.label}</div>
              <div className="text-lg font-semibold mt-0.5">{c.value}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{c.sub}</div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-xl border dark:border-zinc-700 p-4 space-y-2">
        <div className="font-medium">Braintree fees</div>
        <p className="text-sm text-zinc-500">
          Braintree&apos;s API only reports an estimate (~58%) — card-network assessments post around the
          5th. Enter the actual figure from the statement. It rewrites the fee debit and the clearing
          net-down, and updates the posted journal entry in place if the month is already closed.
        </p>
        <div className="flex items-center gap-2">
          <input type="number" step="0.01" min="0" value={btFees} onChange={(e) => setBtFees(e.target.value)}
            placeholder="e.g. 421.88"
            className="border rounded-lg px-3 py-2 w-40 bg-white dark:bg-zinc-900 dark:border-zinc-700" />
          <button onClick={saveBraintreeFees} disabled={!!busy || btFees === ""}
            className="px-3 py-2 rounded-lg border dark:border-zinc-700 disabled:opacity-50">
            {busy === "bt" ? "Saving…" : "Save & rebuild JE"}
          </button>
          {btNote && <span className="text-sm text-zinc-600 dark:text-zinc-400">{btNote}</span>}
        </div>
      </div>

      {run?.steps?.length ? (
        <div className="rounded-xl border dark:border-zinc-700 overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              {run.steps.map((s, i) => (
                <tr key={i} className="border-b last:border-0 dark:border-zinc-800">
                  <td className="px-3 py-2 w-10 text-zinc-500">{s.step >= 0 ? s.step : "!"}</td>
                  <td className="px-3 py-2 font-medium">{s.name}</td>
                  <td className="px-3 py-2">
                    <span className={
                      s.status === "success" ? "text-emerald-600" :
                      s.status === "error" ? "text-red-600" :
                      s.status === "skipped" ? "text-zinc-400" : "text-blue-600"
                    }>{s.status}</span>
                  </td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{s.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="rounded-xl border border-red-300 dark:border-red-800 p-4 space-y-2">
        <div className="font-medium text-red-700 dark:text-red-300">Post to QuickBooks</div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Posts all 5 artifacts. The inventory adjustment and the three sales receipts have no void
          and no dedup — running twice duplicates real documents. Type <code>{month}</code> to confirm.
        </p>
        <div className="flex items-center gap-2">
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={month}
            className="border rounded-lg px-3 py-2 w-40 bg-white dark:bg-zinc-900 dark:border-zinc-700" />
          <button onClick={() => doRun(true)} disabled={!!busy || confirm !== month || !canPost}
            className="px-4 py-2 rounded-lg bg-red-600 text-white disabled:opacity-40">
            {busy === "post" ? "Posting…" : "Post the close"}
          </button>
          {!canPost && <span className="text-sm text-zinc-500">{closed ? "Month already closed." : "Run a passing dry run first."}</span>}
        </div>
      </div>
    </div>
  );
}
