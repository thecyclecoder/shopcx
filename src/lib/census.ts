/**
 * US Census Bureau API client.
 *
 * Pulls zip-code-level demographics from the ACS 5-year estimates, caches
 * results in public.zip_code_demographics (40K US zips max — tiny table),
 * and refreshes annually. Works without an API key but is rate-limited;
 * pass a key (from workspaces.census_api_key_encrypted, decrypted) for
 * higher limits.
 */

import { createAdminClient } from "@/lib/supabase/admin";

const ACS_YEAR = 2022;
const CACHE_TTL_DAYS = 365;
const SUPPRESSED = -666666666; // Census's "data suppressed" sentinel

const VARIABLES = [
  "B19013_001E", // median household income
  "B01002_001E", // median age
  "B25003_001E", // total occupied housing units
  "B25003_002E", // owner-occupied
  "B15003_001E", // population 25+ (education denominator)
  "B15003_022E", // bachelor's degree holders
  "B01003_001E", // total population
];

export type IncomeBracket =
  | "under_40k"
  | "40-60k"
  | "60-80k"
  | "80-100k"
  | "100-125k"
  | "125-150k"
  | "150k+";

export type UrbanClassification = "urban" | "suburban" | "rural";

export interface ZipDemographics {
  zip_code: string;
  median_income: number | null;
  median_age: number | null;
  owner_pct: number | null;
  college_pct: number | null;
  population: number | null;
  population_density: number | null;
  urban_classification: UrbanClassification | null;
  income_bracket: IncomeBracket | null;
  state: string | null;
  acs_year: number;
}

export function incomeToBracket(income: number | null): IncomeBracket | null {
  if (income == null || income <= 0) return null;
  if (income < 40000) return "under_40k";
  if (income < 60000) return "40-60k";
  if (income < 80000) return "60-80k";
  if (income < 100000) return "80-100k";
  if (income < 125000) return "100-125k";
  if (income < 150000) return "125-150k";
  return "150k+";
}

export function classifyUrban(population: number | null): UrbanClassification | null {
  if (population == null || population <= 0) return null;
  if (population > 50000) return "urban";
  if (population > 10000) return "suburban";
  return "rural";
}

function cleanInt(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n) || n === SUPPRESSED) return null;
  return Math.round(n);
}

function cleanNumeric(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n) || n === SUPPRESSED) return null;
  return n;
}

/**
 * Map US state/territory codes to IANA timezone. Uses the most common timezone
 * for states that span multiple zones (e.g., Indiana → America/Indiana/Indianapolis).
 */
const STATE_TIMEZONE: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix",
  AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DE: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise",
  IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago",
  ME: "America/New_York", MD: "America/New_York", MA: "America/New_York",
  MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York",
  NM: "America/Denver", NY: "America/New_York", NC: "America/New_York",
  ND: "America/Chicago", OH: "America/New_York", OK: "America/Chicago",
  OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago",
  TX: "America/Chicago", UT: "America/Denver", VT: "America/New_York",
  VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York",
  WI: "America/Chicago", WY: "America/Denver", DC: "America/New_York",
  PR: "America/Puerto_Rico", GU: "Pacific/Guam", VI: "America/Virgin",
  AS: "Pacific/Pago_Pago", MP: "Pacific/Guam",
};

export function timezoneFromState(stateCode: string | null | undefined): string | null {
  if (!stateCode) return null;
  return STATE_TIMEZONE[stateCode.toUpperCase().trim()] || null;
}

function isFreshCached(fetched_at: string): boolean {
  const fetched = new Date(fetched_at).getTime();
  if (!Number.isFinite(fetched)) return false;
  const ageMs = Date.now() - fetched;
  return ageMs < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Fetch zip demographics. Reads cache first; on miss, calls Census API
 * and upserts the result. Returns null if the zip is invalid or Census
 * has no data for it.
 */
export async function fetchZipDemographics(
  zip: string,
  apiKey?: string,
): Promise<ZipDemographics | null> {
  const cleanZip = (zip || "").trim().replace(/[^0-9]/g, "").slice(0, 5);
  if (cleanZip.length !== 5) return null;

  const admin = createAdminClient();

  // Cache lookup
  const { data: cached } = await admin
    .from("zip_code_demographics")
    .select("*")
    .eq("zip_code", cleanZip)
    .maybeSingle();

  if (cached && isFreshCached(cached.fetched_at)) {
    return {
      zip_code: cleanZip,
      median_income: cached.median_income,
      median_age: cached.median_age,
      owner_pct: cached.owner_pct,
      college_pct: cached.college_pct,
      population: cached.population,
      population_density: cached.population_density,
      urban_classification: cached.urban_classification as UrbanClassification | null,
      income_bracket: cached.income_bracket as IncomeBracket | null,
      state: cached.state,
      acs_year: cached.acs_year ?? ACS_YEAR,
    };
  }

  // Census API call
  const params = new URLSearchParams({
    get: VARIABLES.join(","),
    for: `zip code tabulation area:${cleanZip}`,
  });
  if (apiKey) params.set("key", apiKey);

  const url = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5?${params.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
  } catch {
    return cached ? cachedToZipDemographics(cached, cleanZip) : null;
  }

  if (!response.ok) {
    // If Census has no data for this zip it returns 204/404 — return null,
    // but don't poison the cache.
    return cached ? cachedToZipDemographics(cached, cleanZip) : null;
  }

  const body = await response.json().catch(() => null);
  if (!Array.isArray(body) || body.length < 2) {
    return cached ? cachedToZipDemographics(cached, cleanZip) : null;
  }

  const [headers, values] = body as [string[], (string | number | null)[]];
  const row: Record<string, string | number | null | undefined> = {};
  headers.forEach((h, i) => {
    row[h] = values[i];
  });

  const medianIncome = cleanInt(row["B19013_001E"]);
  const medianAge = cleanNumeric(row["B01002_001E"]);
  const totalHousing = cleanNumeric(row["B25003_001E"]);
  const ownerOccupied = cleanNumeric(row["B25003_002E"]);
  const popEducation = cleanNumeric(row["B15003_001E"]);
  const bachelors = cleanNumeric(row["B15003_022E"]);
  const population = cleanInt(row["B01003_001E"]);

  const ownerPct =
    totalHousing && totalHousing > 0 && ownerOccupied != null
      ? ownerOccupied / totalHousing
      : null;
  const collegePct =
    popEducation && popEducation > 0 && bachelors != null ? bachelors / popEducation : null;

  const result: ZipDemographics = {
    zip_code: cleanZip,
    median_income: medianIncome,
    median_age: medianAge,
    owner_pct: ownerPct,
    college_pct: collegePct,
    population,
    population_density: null,
    urban_classification: classifyUrban(population),
    income_bracket: incomeToBracket(medianIncome),
    state: cleanZip.slice(0, 3) ? stateFromZipPrefix(cleanZip) : null,
    acs_year: ACS_YEAR,
  };

  await admin.from("zip_code_demographics").upsert(
    {
      zip_code: cleanZip,
      median_income: result.median_income,
      median_age: result.median_age,
      owner_pct: result.owner_pct,
      college_pct: result.college_pct,
      population: result.population,
      population_density: result.population_density,
      urban_classification: result.urban_classification,
      income_bracket: result.income_bracket,
      state: result.state,
      acs_year: result.acs_year,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "zip_code" },
  );

  return result;
}

function cachedToZipDemographics(
  cached: Record<string, unknown>,
  cleanZip: string,
): ZipDemographics {
  return {
    zip_code: cleanZip,
    median_income: (cached.median_income as number | null) ?? null,
    median_age: (cached.median_age as number | null) ?? null,
    owner_pct: (cached.owner_pct as number | null) ?? null,
    college_pct: (cached.college_pct as number | null) ?? null,
    population: (cached.population as number | null) ?? null,
    population_density: (cached.population_density as number | null) ?? null,
    urban_classification: (cached.urban_classification as UrbanClassification | null) ?? null,
    income_bracket: (cached.income_bracket as IncomeBracket | null) ?? null,
    state: (cached.state as string | null) ?? null,
    acs_year: (cached.acs_year as number) ?? ACS_YEAR,
  };
}

/**
 * Rough state lookup by zip prefix (first digit → region, first 3 → state).
 * This is good enough for attribution; a precise implementation would use
 * the full ZCTA → state crosswalk.
 */
function stateFromZipPrefix(zip: string): string | null {
  const prefix = parseInt(zip.slice(0, 3), 10);
  if (!Number.isFinite(prefix)) return null;
  const ranges: Array<[number, number, string]> = [
    [0, 27, "MA"],
    [28, 29, "RI"],
    [30, 38, "NH"],
    [39, 49, "ME"],
    [50, 59, "VT"],
    [60, 69, "CT"],
    [70, 89, "NJ"],
    [100, 149, "NY"],
    [150, 196, "PA"],
    [197, 199, "DE"],
    [200, 205, "DC"],
    [206, 219, "MD"],
    [220, 246, "VA"],
    [247, 268, "WV"],
    [270, 289, "NC"],
    [290, 299, "SC"],
    [300, 319, "GA"],
    [320, 349, "FL"],
    [350, 369, "AL"],
    [370, 385, "TN"],
    [386, 397, "MS"],
    [400, 427, "KY"],
    [430, 459, "OH"],
    [460, 479, "IN"],
    [480, 499, "MI"],
    [500, 528, "IA"],
    [530, 549, "WI"],
    [550, 567, "MN"],
    [570, 577, "SD"],
    [580, 588, "ND"],
    [590, 599, "MT"],
    [600, 629, "IL"],
    [630, 658, "MO"],
    [660, 679, "KS"],
    [680, 693, "NE"],
    [700, 715, "LA"],
    [716, 729, "AR"],
    [730, 749, "OK"],
    [750, 799, "TX"],
    [800, 816, "CO"],
    [820, 831, "WY"],
    [832, 838, "ID"],
    [840, 847, "UT"],
    [850, 865, "AZ"],
    [870, 884, "NM"],
    [889, 898, "NV"],
    [900, 961, "CA"],
    [970, 979, "OR"],
    [980, 994, "WA"],
    [995, 999, "AK"],
  ];
  for (const [lo, hi, state] of ranges) {
    if (prefix >= lo && prefix <= hi) return state;
  }
  return null;
}
