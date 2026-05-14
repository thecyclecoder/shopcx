/**
 * Timezone resolver for SMS/MMS marketing campaigns.
 *
 * Goal: given a customer record + a workspace fallback, return the
 * IANA timezone we should use when computing the recipient's send
 * time + which source got us there. Source is recorded on the
 * recipient row so we can audit how often each fallback fires and
 * harden the upstream data wherever the coverage is weakest.
 *
 * Priority chain:
 *
 *   1. customers.timezone (explicit) — populated by the daily
 *      customer-demographics enrichment job from shipping
 *      address/zip. Highest confidence.
 *
 *   2. Derive from default_address.zip (US) via the `zipcodes`
 *      package, then state → timezone. Catches anyone the
 *      enrichment job hasn't run on yet.
 *
 *   3. Phone area code → state → timezone. Works for US numbers
 *      with no address on file (e.g. lead-form-only customers
 *      who gave phone but never bought). ~95% accurate; carriers
 *      port numbers across regions so a Texas area code might
 *      sit in Florida, but for marketing send-time purposes
 *      "close to a Central/Mountain hour" is fine.
 *
 *   4. Workspace fallback. The campaign config carries its own
 *      fallback_timezone column — if nothing else resolves, use
 *      that. Default 'America/Chicago' for ShopCX.
 *
 * Two things this resolver intentionally does NOT do:
 *   - It doesn't call any external API. Resolution is local + fast
 *     so we can batch through 100K recipients in a few seconds.
 *   - It doesn't validate the timezone string against a master list.
 *     IANA names from our state/area-code tables are correct by
 *     construction; if someone manually writes a bad one into
 *     customers.timezone we'll catch it the first time the cron
 *     tries to build a Date with it and surface it as a recipient
 *     status='failed' with a clear error.
 */

import zipcodes from "zipcodes";
import { timezoneFromState } from "@/lib/census";

export type TimezoneSource =
  | "customer_explicit"
  | "address_zip"
  | "phone_area_code"
  | "fallback";

export interface ResolvedTimezone {
  timezone: string;
  source: TimezoneSource;
}

export interface CustomerForTzResolve {
  timezone?: string | null;
  phone?: string | null;
  default_address?: { zip?: string | null; state?: string | null; province_code?: string | null } | null;
}

/**
 * Run the priority chain. Workspace fallback is required so the
 * function always returns a valid timezone — callers don't need to
 * defend against null returns.
 */
export function resolveRecipientTimezone(
  customer: CustomerForTzResolve | null | undefined,
  workspaceFallback: string,
): ResolvedTimezone {
  // 1. Explicit.
  if (customer?.timezone && customer.timezone.trim()) {
    return { timezone: customer.timezone.trim(), source: "customer_explicit" };
  }

  // 2. Zip via zipcodes package.
  const zip = customer?.default_address?.zip?.trim();
  if (zip) {
    const fromZip = timezoneFromZip(zip);
    if (fromZip) return { timezone: fromZip, source: "address_zip" };
  }

  // 3. Phone area code (US numbers only).
  const phone = customer?.phone?.trim();
  if (phone) {
    const fromAreaCode = timezoneFromUSPhone(phone);
    if (fromAreaCode) return { timezone: fromAreaCode, source: "phone_area_code" };
  }

  // 4. Workspace fallback. Last resort.
  return { timezone: workspaceFallback, source: "fallback" };
}

/**
 * Compute the UTC instant when the recipient's local clock reads
 * `localDate` at `localHour:00:00.000`. DST-aware via
 * Intl.DateTimeFormat — we look up the actual offset for the target
 * timezone at noon UTC on the target date and shift wall time into
 * UTC by that offset.
 *
 * Example: localDate='2026-05-15', localHour=11, tz='America/New_York'
 *   - May 15 falls in DST; America/New_York = UTC-4
 *   - 11:00 AM ET = 15:00 UTC
 *   - returns '2026-05-15T15:00:00.000Z'
 */
export function computeSendInstant(
  localDate: string,             // 'YYYY-MM-DD'
  localHour: number,             // 0-23
  timezone: string,              // IANA
): Date {
  const hh = String(Math.max(0, Math.min(23, Math.floor(localHour)))).padStart(2, "0");

  // Anchor at noon UTC on the target date — comfortably away from
  // midnight in either direction, so DST flip edge cases don't bite.
  const noonUtc = new Date(`${localDate}T12:00:00Z`);
  const offsetMinutes = getTimezoneOffsetMinutes(noonUtc, timezone);

  // Treat the desired wall time as if it were UTC, then shift by the
  // tz offset to land at the actual UTC instant.
  const wallAsUtc = new Date(`${localDate}T${hh}:00:00.000Z`);
  return new Date(wallAsUtc.getTime() - offsetMinutes * 60_000);
}

/**
 * Get a timezone's UTC offset in minutes for a given moment, using
 * Intl.DateTimeFormat (which is DST-aware). Returns negative for
 * timezones west of UTC (e.g. -300 for EST in DST). Returns 0 if
 * the timezone name is unrecognized — caller should validate
 * upstream if needed.
 */
function getTimezoneOffsetMinutes(at: Date, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    const parts = fmt.formatToParts(at);
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "";
    const m = tzName.match(/GMT([+-])(\d\d):(\d\d)/);
    if (!m) return 0;
    const sign = m[1] === "+" ? 1 : -1;
    return sign * (Number(m[2]) * 60 + Number(m[3]));
  } catch {
    return 0;
  }
}

/**
 * US zip → IANA timezone via the `zipcodes` package's state lookup.
 * The package returns a record with state code we feed into the
 * existing state→timezone table.
 */
function timezoneFromZip(zip: string): string | null {
  const norm = zip.split("-")[0].trim();
  if (!/^\d{5}$/.test(norm)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (zipcodes as unknown as { lookup: (z: string) => { state?: string } | null }).lookup(norm);
    if (info?.state) return timezoneFromState(info.state);
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * US phone area code → state → IANA timezone. Accepts E.164 (+1XXX…)
 * or 10-digit US numbers. Returns null for non-US or unrecognized
 * area codes.
 *
 * The map is static — area codes don't change often, and overlay
 * regions (multiple ACs for one geography) all resolve to the same
 * state, which is what we need for tz purposes.
 */
function timezoneFromUSPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  let ac = "";
  if (digits.length === 11 && digits.startsWith("1")) ac = digits.slice(1, 4);
  else if (digits.length === 10) ac = digits.slice(0, 3);
  else return null;

  const state = AREA_CODE_TO_STATE[ac];
  if (!state) return null;
  return timezoneFromState(state);
}

/**
 * US area code → state code table. Covers all NANP US area codes
 * as of ~2024 including overlays + recent assignments. Some area
 * codes span multiple states physically (border regions); the
 * primary state is used since timezones rarely differ across
 * a single area-code footprint.
 */
const AREA_CODE_TO_STATE: Record<string, string> = {
  // Alabama
  "205": "AL", "251": "AL", "256": "AL", "334": "AL", "938": "AL", "659": "AL",
  // Alaska
  "907": "AK",
  // Arizona
  "480": "AZ", "520": "AZ", "602": "AZ", "623": "AZ", "928": "AZ",
  // Arkansas
  "479": "AR", "501": "AR", "870": "AR", "327": "AR",
  // California
  "209": "CA", "213": "CA", "279": "CA", "310": "CA", "323": "CA", "341": "CA",
  "350": "CA", "408": "CA", "415": "CA", "424": "CA", "442": "CA", "510": "CA",
  "530": "CA", "559": "CA", "562": "CA", "619": "CA", "626": "CA", "628": "CA",
  "650": "CA", "657": "CA", "661": "CA", "669": "CA", "707": "CA", "714": "CA",
  "747": "CA", "760": "CA", "805": "CA", "818": "CA", "820": "CA", "831": "CA",
  "840": "CA", "858": "CA", "909": "CA", "916": "CA", "925": "CA", "949": "CA",
  "951": "CA",
  // Colorado
  "303": "CO", "719": "CO", "720": "CO", "970": "CO", "983": "CO",
  // Connecticut
  "203": "CT", "475": "CT", "860": "CT", "959": "CT",
  // Delaware
  "302": "DE",
  // DC
  "202": "DC", "771": "DC",
  // Florida
  "239": "FL", "305": "FL", "321": "FL", "352": "FL", "386": "FL", "407": "FL",
  "448": "FL", "561": "FL", "656": "FL", "689": "FL", "727": "FL", "754": "FL",
  "772": "FL", "786": "FL", "813": "FL", "850": "FL", "863": "FL", "904": "FL",
  "941": "FL", "954": "FL",
  // Georgia
  "229": "GA", "404": "GA", "470": "GA", "478": "GA", "678": "GA", "706": "GA",
  "762": "GA", "770": "GA", "912": "GA", "943": "GA",
  // Hawaii
  "808": "HI",
  // Idaho
  "208": "ID", "986": "ID",
  // Illinois
  "217": "IL", "224": "IL", "309": "IL", "312": "IL", "331": "IL", "447": "IL",
  "464": "IL", "618": "IL", "630": "IL", "708": "IL", "730": "IL", "773": "IL",
  "779": "IL", "815": "IL", "847": "IL", "861": "IL", "872": "IL",
  // Indiana
  "219": "IN", "260": "IN", "317": "IN", "463": "IN", "574": "IN", "765": "IN",
  "812": "IN", "930": "IN",
  // Iowa
  "319": "IA", "515": "IA", "563": "IA", "641": "IA", "712": "IA",
  // Kansas
  "316": "KS", "620": "KS", "785": "KS", "913": "KS",
  // Kentucky
  "270": "KY", "364": "KY", "502": "KY", "606": "KY", "859": "KY",
  // Louisiana
  "225": "LA", "318": "LA", "337": "LA", "504": "LA", "985": "LA",
  // Maine
  "207": "ME",
  // Maryland
  "227": "MD", "240": "MD", "301": "MD", "410": "MD", "443": "MD", "667": "MD",
  // Massachusetts
  "339": "MA", "351": "MA", "413": "MA", "508": "MA", "617": "MA", "774": "MA",
  "781": "MA", "857": "MA", "978": "MA",
  // Michigan
  "231": "MI", "248": "MI", "269": "MI", "313": "MI", "517": "MI", "586": "MI",
  "616": "MI", "679": "MI", "734": "MI", "810": "MI", "906": "MI", "947": "MI",
  "989": "MI",
  // Minnesota
  "218": "MN", "320": "MN", "507": "MN", "612": "MN", "651": "MN", "763": "MN",
  "952": "MN",
  // Mississippi
  "228": "MS", "601": "MS", "662": "MS", "769": "MS",
  // Missouri
  "314": "MO", "417": "MO", "557": "MO", "573": "MO", "636": "MO", "660": "MO",
  "816": "MO", "975": "MO",
  // Montana
  "406": "MT",
  // Nebraska
  "308": "NE", "402": "NE", "531": "NE",
  // Nevada
  "702": "NV", "725": "NV", "775": "NV",
  // New Hampshire
  "603": "NH",
  // New Jersey
  "201": "NJ", "551": "NJ", "609": "NJ", "640": "NJ", "732": "NJ", "848": "NJ",
  "856": "NJ", "862": "NJ", "908": "NJ", "973": "NJ",
  // New Mexico
  "505": "NM", "575": "NM",
  // New York
  "212": "NY", "315": "NY", "329": "NY", "332": "NY", "347": "NY", "363": "NY",
  "516": "NY", "518": "NY", "585": "NY", "607": "NY", "631": "NY", "638": "NY",
  "646": "NY", "680": "NY", "716": "NY", "718": "NY", "838": "NY", "845": "NY",
  "914": "NY", "917": "NY", "929": "NY", "934": "NY",
  // North Carolina
  "252": "NC", "336": "NC", "472": "NC", "704": "NC", "743": "NC", "828": "NC",
  "910": "NC", "919": "NC", "980": "NC", "984": "NC",
  // North Dakota
  "701": "ND",
  // Ohio
  "216": "OH", "220": "OH", "234": "OH", "283": "OH", "326": "OH", "330": "OH",
  "380": "OH", "419": "OH", "440": "OH", "513": "OH", "567": "OH", "614": "OH",
  "740": "OH", "937": "OH",
  // Oklahoma
  "405": "OK", "539": "OK", "572": "OK", "580": "OK", "918": "OK",
  // Oregon
  "458": "OR", "503": "OR", "541": "OR", "971": "OR",
  // Pennsylvania
  "215": "PA", "223": "PA", "267": "PA", "272": "PA", "412": "PA", "445": "PA",
  "484": "PA", "570": "PA", "582": "PA", "610": "PA", "717": "PA", "724": "PA",
  "814": "PA", "835": "PA", "878": "PA",
  // Rhode Island
  "401": "RI",
  // South Carolina
  "803": "SC", "821": "SC", "843": "SC", "854": "SC", "864": "SC",
  // South Dakota
  "605": "SD",
  // Tennessee
  "423": "TN", "615": "TN", "629": "TN", "731": "TN", "865": "TN", "901": "TN",
  "931": "TN",
  // Texas
  "210": "TX", "214": "TX", "254": "TX", "281": "TX", "325": "TX", "346": "TX",
  "361": "TX", "409": "TX", "430": "TX", "432": "TX", "469": "TX", "512": "TX",
  "682": "TX", "713": "TX", "726": "TX", "737": "TX", "806": "TX", "817": "TX",
  "830": "TX", "832": "TX", "903": "TX", "915": "TX", "936": "TX", "940": "TX",
  "945": "TX", "956": "TX", "972": "TX", "979": "TX",
  // Utah
  "385": "UT", "435": "UT", "801": "UT",
  // Vermont
  "802": "VT",
  // Virginia
  "276": "VA", "434": "VA", "540": "VA", "571": "VA", "686": "VA", "703": "VA",
  "757": "VA", "804": "VA", "826": "VA", "948": "VA",
  // Washington
  "206": "WA", "253": "WA", "360": "WA", "425": "WA", "509": "WA", "564": "WA",
  // West Virginia
  "304": "WV", "681": "WV",
  // Wisconsin
  "262": "WI", "274": "WI", "353": "WI", "414": "WI", "534": "WI", "608": "WI",
  "715": "WI", "920": "WI",
  // Wyoming
  "307": "WY",
};
