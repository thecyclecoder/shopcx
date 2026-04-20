/**
 * Versium REACH API client — demographic append.
 *
 * Enriches customer records with real demographic data (age, income, gender,
 * interests, household composition) instead of AI inference from names.
 *
 * Docs: https://api-documentation.versium.com/reference/demographic-append-api
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

export interface VersiumDemographics {
  // Personal
  gender: string | null;
  age_range: string | null;
  education_level: string | null;
  marital_status: string | null;
  language: string | null;
  occupation: string | null;

  // Financial
  household_income: string | null;
  estimated_net_worth: string | null;
  credit_rating: string | null;
  home_owner: boolean | null;
  home_market_value: string | null;

  // Household
  household_size: string | null;
  number_of_children: string | null;
  presence_of_children: string | null;
  number_of_adults: string | null;
  senior_in_household: string | null;

  // Lifestyle interests (boolean flags)
  interest_health_beauty: boolean;
  interest_exercise: boolean;
  interest_diet_weight_loss: boolean;
  interest_vitamins: boolean;
  interest_cooking: boolean;
  interest_travel: boolean;
  interest_pets: boolean;
  interest_gardening: boolean;
  interest_reading: boolean;

  // Online behavior
  online_purchasing: boolean;

  // Raw response for debugging
  raw: Record<string, unknown>;
}

export interface VersiumInput {
  email?: string;
  first_name?: string;
  last_name?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
}

async function getVersiumApiKey(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("versium_api_key_encrypted")
    .eq("id", workspaceId)
    .single();
  if (!data?.versium_api_key_encrypted) return null;
  return decrypt(data.versium_api_key_encrypted);
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "y" || v.toLowerCase() === "yes" || v === "1";
  return false;
}

function normalizeAgeRange(v: string | null): string | null {
  if (!v) return null;
  // Versium returns ranges like "25-34", "35-44" etc. — map to our schema
  const clean = v.replace(/\s/g, "");
  const map: Record<string, string> = {
    "18-24": "under_25",
    "25-34": "25-34",
    "35-44": "35-44",
    "45-54": "45-54",
    "55-64": "55-64",
    "65-74": "65+",
    "75+": "65+",
    "65+": "65+",
  };
  return map[clean] || v;
}

function normalizeGender(v: string | null): string | null {
  if (!v) return null;
  const lower = v.toLowerCase().trim();
  if (lower === "f" || lower === "female") return "female";
  if (lower === "m" || lower === "male") return "male";
  return "unknown";
}

export async function fetchVersiumDemographics(
  workspaceId: string,
  input: VersiumInput,
): Promise<VersiumDemographics | null> {
  const apiKey = await getVersiumApiKey(workspaceId);
  if (!apiKey) return null;

  // Build query params — send everything we have
  const params = new URLSearchParams();
  params.set("output[]", "full_demographic");
  params.set("cfg_maxrecs", "1");
  if (input.email) params.set("email", input.email);
  if (input.first_name) params.set("first", input.first_name);
  if (input.last_name) params.set("last", input.last_name);
  if (input.address) params.set("address", input.address);
  if (input.city) params.set("city", input.city);
  if (input.state) params.set("state", input.state);
  if (input.zip) params.set("zip", input.zip.slice(0, 5));
  if (input.phone) params.set("phone", input.phone.replace(/\D/g, ""));

  // Need at least one identifier
  if (!input.email && !input.phone && !input.first_name) return null;

  try {
    const res = await fetch(`https://api.versium.com/v2/demographic?${params}`, {
      headers: { "x-versium-api-key": apiKey },
      cache: "no-store",
    });

    if (!res.ok) {
      console.error("[versium] API error:", res.status, await res.text().catch(() => ""));
      return null;
    }

    const data = await res.json();
    const results = data?.versium?.results || [];
    if (results.length === 0) return null;

    const r = results[0] as Record<string, unknown>;

    return {
      gender: normalizeGender(r["Gender"] as string | null),
      age_range: normalizeAgeRange(r["Age Range"] as string | null),
      education_level: (r["Education Level"] as string) || null,
      marital_status: (r["Marital Status"] as string) || null,
      language: (r["Language"] as string) || null,
      occupation: (r["Occupation"] as string) || null,

      household_income: (r["Household Income"] as string) || null,
      estimated_net_worth: (r["Estimated Net Worth"] as string) || null,
      credit_rating: (r["Credit Rating"] as string) || null,
      home_owner: r["Home Own or Rent"] ? (r["Home Own or Rent"] as string).toLowerCase().includes("own") : null,
      home_market_value: (r["Home Market Value"] as string) || null,

      household_size: (r["Household Size"] as string) || null,
      number_of_children: (r["Number of Children"] as string) || null,
      presence_of_children: (r["Presence of Children"] as string) || null,
      number_of_adults: (r["Number of Adults"] as string) || null,
      senior_in_household: (r["Senior in Household"] as string) || null,

      interest_health_beauty: toBool(r["Health and Beauty"]),
      interest_exercise: toBool(r["Exercise"]),
      interest_diet_weight_loss: toBool(r["Diet Weight Loss"]) || toBool(r["Dieting/Weight Loss"]),
      interest_vitamins: toBool(r["Vitamins"]) || toBool(r["Health/Medical"]),
      interest_cooking: toBool(r["Cooking"]),
      interest_travel: toBool(r["Travel Domestic"]) || toBool(r["Travel International"]),
      interest_pets: toBool(r["Pets"]),
      interest_gardening: toBool(r["Gardening"]),
      interest_reading: toBool(r["Reading"]),

      online_purchasing: toBool(r["Online Purchasing Indicator"]),

      raw: r,
    };
  } catch (err) {
    console.error("[versium] Fetch failed:", err);
    return null;
  }
}
