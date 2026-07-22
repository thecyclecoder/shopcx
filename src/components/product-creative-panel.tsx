"use client";

/**
 * ProductCreativePanel — the four vertical blocks that make the v3 ad-creative engine visible on the
 * product page (docs/brain/specs/products-ui-creative-engine-visibility.md Phase 1):
 *   (1) Angle palette (from public.product_angle_palette via [[../lib/ads/angle-palette]] listAnglePalette).
 *   (2) Active tests (public.ad_campaigns status='active' + product_id, with the four v3 factor stamps).
 *   (3) Top combinations by ROAS (from the factor-rollup SDK once shipped — the SDK's blocked_by
 *       spec has only landed its policies table + resolver so far; this block renders a "waiting"
 *       state that will be swapped for the SDK read the moment getFactorRollup lands).
 *   (4) Latest 6 creative previews (ad_campaigns rows with hero_image_url set).
 *
 * The palette is server-rendered and handed in as `palette`; the active tests + latest previews
 * come from GET /api/products/[id]/creative-panel (client fetch, workspaceId via useWorkspace).
 *
 * Every root container respects the mobile-dashboard-design invariants (mx-auto w-full max-w-*)
 * and every wide table is wrapped in `.overflow-x-auto` per docs/brain/reference/ui-conventions.md.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { errText } from "@/lib/error-text";
import { useWorkspace } from "@/lib/workspace-context";
import type { ProductAngle } from "@/lib/ads/angle-palette";

// Mirrors the AdCreativePanelRow shape from [[../lib/ads/ads-read-sdk]] listAdsForCreativePanel;
// re-declared here so this client component does not import server-only types.
interface AdRow {
  id: string;
  name: string | null;
  status: string | null;
  audienceTemperature: "cold" | "warm" | "hot" | null;
  creativeTheme: string | null;
  anglePaletteId: string | null;
  headlinePatternId: string | null;
  creativeCombinationId: string | null;
  heroImageUrl: string | null;
  createdAt: string | null;
}

interface PanelResponse {
  activeTests: AdRow[];
  latestPreviews: AdRow[];
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "crowned":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
    case "testing":
      return "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300";
    case "retired":
      return "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
    default:
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  }
}

function tempBadgeClass(t: string | null): string {
  switch (t) {
    case "cold":
      return "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300";
    case "warm":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
    case "hot":
      return "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300";
    default:
      return "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ProductCreativePanel({
  productId,
  productTitle,
  palette,
}: {
  productId: string;
  productTitle: string | null;
  palette: ProductAngle[];
}) {
  const workspace = useWorkspace();
  const [panel, setPanel] = useState<PanelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [significanceGateOn, setSignificanceGateOn] = useState(true);

  const load = useCallback(async () => {
    if (!workspace.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/products/${productId}/creative-panel?workspaceId=${workspace.id}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as PanelResponse;
      setPanel(json);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [productId, workspace.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const themes = Array.from(new Set(palette.map((p) => p.theme)));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Creative — {productTitle ?? "Product"}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          The v3 ad-creative engine's output for this product: the live angle palette, currently
          active tests, top combinations by ROAS, and the latest six creative previews.
        </p>
      </header>

      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      <PaletteBlock palette={palette} themes={themes} />

      <ActiveTestsBlock rows={panel?.activeTests ?? []} loading={loading} />

      <TopCombinationsBlock
        significanceGateOn={significanceGateOn}
        setSignificanceGateOn={setSignificanceGateOn}
      />

      <LatestPreviewsBlock rows={panel?.latestPreviews ?? []} loading={loading} />
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
          {subtitle ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
          ) : null}
        </div>
        {right ? <div className="flex items-center gap-2">{right}</div> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function PaletteBlock({ palette, themes }: { palette: ProductAngle[]; themes: string[] }) {
  return (
    <SectionCard
      title="Angle palette"
      subtitle={
        palette.length === 0
          ? "No palette yet — seed this product's angle palette first."
          : `${palette.length} angle${palette.length === 1 ? "" : "s"} across ${themes.length} theme${themes.length === 1 ? "" : "s"}: ${themes.join(", ")}`
      }
    >
      {palette.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Angle palette is empty. See{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">
            scripts/_seed-angle-palette-*.ts
          </code>
          .
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="py-2 pr-4">Theme</th>
                <th className="py-2 pr-4">Problem</th>
                <th className="py-2 pr-4">Ingredients</th>
                <th className="py-2 pr-4">Evidence</th>
                <th className="py-2 pr-4">Demand</th>
                <th className="py-2 pr-4">Used</th>
                <th className="py-2 pr-4">Last used</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Active</th>
              </tr>
            </thead>
            <tbody>
              {palette.map((a) => (
                <tr
                  key={a.id}
                  className="border-b border-zinc-100 align-top last:border-b-0 dark:border-zinc-900"
                >
                  <td className="py-2 pr-4 font-medium text-zinc-900 dark:text-zinc-100">{a.theme}</td>
                  <td className="py-2 pr-4 text-zinc-700 dark:text-zinc-300">{a.problem}</td>
                  <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                    {a.ingredients.length > 0 ? a.ingredients.join(", ") : "—"}
                  </td>
                  <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{a.evidenceTier}</td>
                  <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{a.searchDemand}</td>
                  <td className="py-2 pr-4 tabular-nums text-zinc-600 dark:text-zinc-400">
                    {a.timesUsed}
                  </td>
                  <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{fmtDate(a.lastUsedAt)}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeClass(a.status)}`}
                    >
                      {a.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    {a.isActive ? (
                      <span className="text-emerald-600 dark:text-emerald-400">yes</span>
                    ) : (
                      <span className="text-zinc-400 dark:text-zinc-500">no</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function StampBadge({ label, value }: { label: string; value: string | null }) {
  if (!value) return <span className="text-zinc-400 dark:text-zinc-500">—</span>;
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
      <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        {value.length > 8 ? `${value.slice(0, 8)}…` : value}
      </code>
    </span>
  );
}

function ActiveTestsBlock({ rows, loading }: { rows: AdRow[]; loading: boolean }) {
  return (
    <SectionCard
      title="Active tests"
      subtitle={
        loading
          ? "Loading…"
          : `${rows.length} active ${rows.length === 1 ? "ad" : "ads"} — each carries its v3 factor stamps for attribution.`
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {loading ? "Loading active tests…" : "No active ads for this product yet."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="py-2 pr-4">Ad</th>
                <th className="py-2 pr-4">Theme</th>
                <th className="py-2 pr-4">Temp</th>
                <th className="py-2 pr-4">Stamps</th>
                <th className="py-2 pr-4">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-zinc-100 align-top last:border-b-0 dark:border-zinc-900"
                >
                  <td className="py-2 pr-4">
                    <Link
                      href={`/dashboard/marketing/ads/${r.id}`}
                      className="font-medium text-sky-700 hover:underline dark:text-sky-400"
                    >
                      {r.name ?? r.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-zinc-700 dark:text-zinc-300">
                    {r.creativeTheme ?? "—"}
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tempBadgeClass(r.audienceTemperature)}`}
                    >
                      {r.audienceTemperature ?? "—"}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-col gap-1">
                      <StampBadge label="angle" value={r.anglePaletteId} />
                      <StampBadge label="pattern" value={r.headlinePatternId} />
                      <StampBadge label="combo" value={r.creativeCombinationId} />
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{fmtDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function TopCombinationsBlock({
  significanceGateOn,
  setSignificanceGateOn,
}: {
  significanceGateOn: boolean;
  setSignificanceGateOn: (v: boolean) => void;
}) {
  return (
    <SectionCard
      title="Top combinations by ROAS"
      subtitle="Ranked by the factor-rollup SDK. Significance-gate filters bins that haven't cleared the workspace-tuned spend + purchases thresholds."
      right={
        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            className="h-3.5 w-3.5"
            checked={significanceGateOn}
            onChange={(e) => setSignificanceGateOn(e.target.checked)}
          />
          Significance gate {significanceGateOn ? "on" : "off"}
        </label>
      }
    >
      {/*
        The `getFactorRollup(admin, workspaceId, productId, {gate})` reader lands in Phase 2 of the
        blocked_by spec [[factor-rollup-sdk-with-significance-gate]] — only its policies resolver
        (`resolveFactorRollupThresholds`) has shipped so far. Until the SDK function exists, this
        block renders a "waiting on SDK" state rather than hand-rolling a `.from("ad_creative_combinations")`
        probe here (the repo-wide "Raw `.from(...)` with no SDK → STOP" rail). When the SDK ships,
        wire it into `/api/products/[id]/creative-panel` and pass the rollup rows in as a prop.
      */}
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Waiting on the <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">getFactorRollup</code> reader (Phase 2 of the factor-rollup-sdk-with-significance-gate spec). Rankings will render here as soon as the SDK ships.
      </p>
    </SectionCard>
  );
}

function LatestPreviewsBlock({ rows, loading }: { rows: AdRow[]; loading: boolean }) {
  return (
    <SectionCard
      title="Latest creative previews"
      subtitle={loading ? "Loading…" : `${rows.length} newest ad${rows.length === 1 ? "" : "s"} (image + audience temperature).`}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {loading ? "Loading previews…" : "No creative previews yet — Dahlia has not authored ads for this product."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/dashboard/marketing/ads/${r.id}`}
              className="group flex flex-col overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 transition hover:border-sky-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-sky-700"
            >
              <div className="relative aspect-square w-full overflow-hidden bg-zinc-100 dark:bg-zinc-800">
                {r.heroImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.heroImageUrl}
                    alt={r.name ?? "creative preview"}
                    className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-zinc-400">
                    no image
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1 p-2">
                <div className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                  {r.name ?? r.id.slice(0, 8)}
                </div>
                <div className="flex items-center gap-1">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tempBadgeClass(r.audienceTemperature)}`}
                  >
                    {r.audienceTemperature ?? "—"}
                  </span>
                  {r.creativeTheme ? (
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      {r.creativeTheme}
                    </span>
                  ) : null}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

export default ProductCreativePanel;
