"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

const CONFIDENCE_FLOOR = 0.65;

interface Demographics {
  inferred_gender: string | null;
  inferred_gender_conf: number | null;
  inferred_age_range: string | null;
  inferred_age_conf: number | null;
  zip_code: string | null;
  zip_income_bracket: string | null;
  zip_urban_classification: string | null;
  buyer_type: string | null;
  health_priorities: string[] | null;
  census_data_year: number | null;
  enriched_at: string | null;
}

const INCOME_LABELS: Record<string, string> = {
  under_40k: "Under $40K",
  "40-60k": "$40-60K",
  "60-80k": "$60-80K",
  "80-100k": "$80-100K",
  "100-125k": "$100-125K",
  "125-150k": "$125-150K",
  "150k+": "$150K+",
};

const BUYER_LABELS: Record<string, string> = {
  committed_subscriber: "Committed subscriber",
  new_subscriber: "New subscriber",
  lapsed_subscriber: "Lapsed subscriber",
  value_buyer: "Value buyer",
  cautious_buyer: "Cautious buyer",
  one_time_buyer: "One-time buyer",
};

const GENDER_LABELS: Record<string, string> = {
  female: "Women",
  male: "Men",
  unknown: "",
};

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Compact demographic card — only shows fields whose confidence / data is
 * strong enough to display. Returns null if nothing worth showing.
 */
export default function CustomerDemographicsCard({ customerId }: { customerId: string }) {
  const workspace = useWorkspace();
  const [demographics, setDemographics] = useState<Demographics | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspace.id}/customers/${customerId}/demographics`)
      .then((r) => (r.ok ? r.json() : { demographics: null }))
      .then((data) => {
        if (cancelled) return;
        setDemographics(data.demographics || null);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id, customerId]);

  if (!loaded) return null;
  if (!demographics) return null;

  const showGender =
    demographics.inferred_gender &&
    demographics.inferred_gender !== "unknown" &&
    (demographics.inferred_gender_conf ?? 0) >= CONFIDENCE_FLOOR;

  const showAge =
    demographics.inferred_age_range && (demographics.inferred_age_conf ?? 0) >= CONFIDENCE_FLOOR;

  const showIncome = !!demographics.zip_income_bracket;
  const showUrban = !!demographics.zip_urban_classification;
  const showBuyer = !!demographics.buyer_type;
  const priorities = (demographics.health_priorities || []).slice(0, 4);

  if (!showGender && !showAge && !showIncome && !showUrban && !showBuyer && priorities.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-2 text-sm font-medium uppercase text-zinc-500">Demographics</p>
      <div className="flex flex-wrap gap-1.5">
        {showGender && demographics.inferred_gender && (
          <Badge
            color="violet"
            label={GENDER_LABELS[demographics.inferred_gender] || demographics.inferred_gender}
            hint={`${Math.round((demographics.inferred_gender_conf || 0) * 100)}% confident`}
          />
        )}
        {showAge && demographics.inferred_age_range && (
          <Badge
            color="indigo"
            label={`Age ${demographics.inferred_age_range}`}
            hint={`${Math.round((demographics.inferred_age_conf || 0) * 100)}% confident`}
          />
        )}
        {showIncome && demographics.zip_income_bracket && (
          <Badge
            color="emerald"
            label={INCOME_LABELS[demographics.zip_income_bracket] || demographics.zip_income_bracket}
            hint="US Census ACS"
          />
        )}
        {showUrban && demographics.zip_urban_classification && (
          <Badge color="amber" label={titleCase(demographics.zip_urban_classification)} />
        )}
        {showBuyer && demographics.buyer_type && (
          <Badge
            color="zinc"
            label={BUYER_LABELS[demographics.buyer_type] || titleCase(demographics.buyer_type)}
          />
        )}
      </div>

      {priorities.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">Health priorities</p>
          <div className="flex flex-wrap gap-1.5">
            {priorities.map((p) => (
              <span
                key={p}
                className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              >
                {titleCase(p)}
              </span>
            ))}
          </div>
        </div>
      )}

      {demographics.zip_code && (
        <p className="mt-3 text-[10px] text-zinc-400">
          Zip {demographics.zip_code} · US Census ACS {demographics.census_data_year || 2022}
        </p>
      )}
    </div>
  );
}

const COLOR_CLASSES: Record<string, string> = {
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  zinc: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

function Badge({ color, label, hint }: { color: string; label: string; hint?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        COLOR_CLASSES[color] || COLOR_CLASSES.zinc
      }`}
      title={hint}
    >
      {label}
    </span>
  );
}
