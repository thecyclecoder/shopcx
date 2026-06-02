/**
 * Phase 1d — enrich customers.timezone and address fields from
 * klaviyo_profile_staging using the resolver chain:
 *
 *   1. staging.timezone (Klaviyo's direct value) → use
 *   2. staging.zip → zipcodes package lookup → tz
 *   3. staging.region + staging.country → US state default tz
 *   4. customers.phone → US area code → tz
 *
 * Only updates customers where the target column is currently NULL.
 * Idempotent — safe to re-run.
 *
 * Also fills default_address (built from staging) and first_name /
 * last_name when those are NULL.
 *
 * Usage:
 *   npx tsx scripts/enrich-customers-from-staging.ts
 *   npx tsx scripts/enrich-customers-from-staging.ts --dry-run
 */

import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

import { createClient } from "@supabase/supabase-js";
import zipcodes from "zipcodes";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DRY_RUN = process.argv.includes("--dry-run");

// US state code → default tz (the populated region of the state)
const STATE_TZ: Record<string, string> = {
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
  PR: "America/Puerto_Rico",
};

// Spelled-out → 2-letter code (Klaviyo sometimes returns full names)
const REGION_TO_CODE: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
  "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC", "puerto rico": "PR",
};

// US/Canada area code → state/province code (NANP complete as of 2026).
// We derive tz by chaining: phone → area code → state → STATE_TZ.
const AREA_CODE_STATE: Record<string, string> = {
  // Alabama
  "205":"AL","251":"AL","256":"AL","334":"AL","659":"AL","938":"AL",
  // Alaska
  "907":"AK",
  // Arizona
  "480":"AZ","520":"AZ","602":"AZ","623":"AZ","928":"AZ",
  // Arkansas
  "479":"AR","501":"AR","870":"AR","327":"AR",
  // California
  "209":"CA","213":"CA","279":"CA","310":"CA","323":"CA","341":"CA","350":"CA","357":"CA","369":"CA","408":"CA","415":"CA","424":"CA","442":"CA","510":"CA","530":"CA","559":"CA","562":"CA","619":"CA","626":"CA","628":"CA","650":"CA","657":"CA","661":"CA","669":"CA","707":"CA","714":"CA","738":"CA","747":"CA","760":"CA","805":"CA","818":"CA","820":"CA","831":"CA","837":"CA","840":"CA","858":"CA","909":"CA","916":"CA","925":"CA","949":"CA","951":"CA",
  // Colorado
  "303":"CO","719":"CO","720":"CO","748":"CO","970":"CO","983":"CO",
  // Connecticut
  "203":"CT","475":"CT","860":"CT","959":"CT",
  // Delaware
  "302":"DE",
  // DC
  "202":"DC","771":"DC",
  // Florida
  "239":"FL","305":"FL","321":"FL","324":"FL","352":"FL","386":"FL","407":"FL","448":"FL","561":"FL","656":"FL","689":"FL","727":"FL","728":"FL","754":"FL","772":"FL","786":"FL","813":"FL","850":"FL","863":"FL","904":"FL","941":"FL","954":"FL",
  // Georgia
  "229":"GA","404":"GA","470":"GA","478":"GA","678":"GA","706":"GA","762":"GA","770":"GA","912":"GA","943":"GA",
  // Hawaii
  "808":"HI",
  // Idaho
  "208":"ID","986":"ID",
  // Illinois
  "217":"IL","224":"IL","309":"IL","312":"IL","331":"IL","447":"IL","464":"IL","618":"IL","630":"IL","708":"IL","730":"IL","773":"IL","779":"IL","815":"IL","847":"IL","861":"IL","872":"IL",
  // Indiana
  "219":"IN","260":"IN","317":"IN","463":"IN","574":"IN","765":"IN","812":"IN","930":"IN",
  // Iowa
  "319":"IA","515":"IA","563":"IA","641":"IA","712":"IA",
  // Kansas
  "316":"KS","620":"KS","785":"KS","913":"KS",
  // Kentucky
  "270":"KY","364":"KY","502":"KY","606":"KY","859":"KY",
  // Louisiana
  "225":"LA","318":"LA","337":"LA","457":"LA","504":"LA","985":"LA",
  // Maine
  "207":"ME",
  // Maryland
  "227":"MD","240":"MD","301":"MD","410":"MD","443":"MD","667":"MD",
  // Massachusetts
  "339":"MA","351":"MA","413":"MA","508":"MA","617":"MA","774":"MA","781":"MA","857":"MA","978":"MA",
  // Michigan
  "231":"MI","248":"MI","269":"MI","313":"MI","517":"MI","586":"MI","616":"MI","679":"MI","734":"MI","810":"MI","906":"MI","947":"MI","989":"MI",
  // Minnesota
  "218":"MN","320":"MN","507":"MN","612":"MN","651":"MN","763":"MN","924":"MN","952":"MN",
  // Mississippi
  "228":"MS","471":"MS","601":"MS","662":"MS","769":"MS",
  // Missouri
  "235":"MO","314":"MO","417":"MO","557":"MO","573":"MO","636":"MO","660":"MO","816":"MO","975":"MO",
  // Montana
  "406":"MT",
  // Nebraska
  "308":"NE","402":"NE","531":"NE",
  // Nevada
  "702":"NV","725":"NV","775":"NV",
  // New Hampshire
  "603":"NH",
  // New Jersey
  "201":"NJ","551":"NJ","609":"NJ","640":"NJ","732":"NJ","848":"NJ","856":"NJ","862":"NJ","908":"NJ","973":"NJ",
  // New Mexico
  "505":"NM","575":"NM",
  // New York
  "212":"NY","315":"NY","332":"NY","347":"NY","363":"NY","516":"NY","518":"NY","585":"NY","607":"NY","624":"NY","631":"NY","645":"NY","646":"NY","680":"NY","716":"NY","718":"NY","838":"NY","845":"NY","914":"NY","917":"NY","929":"NY","934":"NY",
  // North Carolina
  "252":"NC","336":"NC","472":"NC","704":"NC","743":"NC","828":"NC","910":"NC","919":"NC","980":"NC","984":"NC",
  // North Dakota
  "701":"ND",
  // Ohio
  "216":"OH","220":"OH","234":"OH","283":"OH","326":"OH","330":"OH","380":"OH","419":"OH","436":"OH","440":"OH","513":"OH","567":"OH","614":"OH","740":"OH","937":"OH",
  // Oklahoma
  "405":"OK","539":"OK","572":"OK","580":"OK","918":"OK",
  // Oregon
  "458":"OR","503":"OR","541":"OR","971":"OR",
  // Pennsylvania
  "215":"PA","223":"PA","267":"PA","272":"PA","412":"PA","445":"PA","484":"PA","570":"PA","582":"PA","610":"PA","717":"PA","724":"PA","814":"PA","835":"PA","878":"PA",
  // Rhode Island
  "401":"RI",
  // South Carolina
  "803":"SC","821":"SC","839":"SC","843":"SC","854":"SC","864":"SC",
  // South Dakota
  "605":"SD",
  // Tennessee
  "423":"TN","615":"TN","629":"TN","731":"TN","865":"TN","901":"TN","931":"TN",
  // Texas
  "210":"TX","214":"TX","254":"TX","281":"TX","325":"TX","346":"TX","361":"TX","409":"TX","430":"TX","432":"TX","469":"TX","512":"TX","620":"TX","682":"TX","713":"TX","726":"TX","737":"TX","806":"TX","817":"TX","830":"TX","832":"TX","903":"TX","915":"TX","936":"TX","940":"TX","945":"TX","956":"TX","972":"TX","979":"TX",
  // Utah
  "385":"UT","435":"UT","801":"UT",
  // Vermont
  "802":"VT",
  // Virginia
  "276":"VA","434":"VA","540":"VA","571":"VA","686":"VA","703":"VA","757":"VA","804":"VA","826":"VA","948":"VA",
  // Washington
  "206":"WA","253":"WA","360":"WA","425":"WA","509":"WA","564":"WA",
  // West Virginia
  "304":"WV","681":"WV",
  // Wisconsin
  "262":"WI","274":"WI","353":"WI","414":"WI","534":"WI","608":"WI","715":"WI","920":"WI",
  // Wyoming
  "307":"WY",
  // Puerto Rico
  "787":"PR","939":"PR",
};

interface StagingRow {
  klaviyo_profile_id: string;
  customer_id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  region: string | null;
  zip: string | null;
  country: string | null;
  timezone: string | null;
}

interface Customer {
  id: string;
  timezone: string | null;
  default_address: unknown;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
}

function resolveTimezone(s: StagingRow, c: Customer): { tz: string | null; method: string | null } {
  // 1. Klaviyo direct
  if (s.timezone) return { tz: s.timezone, method: "klaviyo_direct" };
  // 2. zip → tz
  if (s.zip) {
    const z = zipcodes.lookup(s.zip);
    if (z?.timezone) {
      // zipcodes returns offset names like "Eastern" — map to IANA
      const m: Record<string, string> = {
        "Eastern": "America/New_York", "Central": "America/Chicago",
        "Mountain": "America/Denver", "Pacific": "America/Los_Angeles",
        "Hawaii-Aleutian": "Pacific/Honolulu", "Alaska": "America/Anchorage",
      };
      if (m[z.timezone]) return { tz: m[z.timezone], method: "zip" };
    }
    // Fallback: lookup state via zip, then state default
    if (z?.state && STATE_TZ[z.state]) return { tz: STATE_TZ[z.state], method: "zip_state" };
  }
  // 3. region+country (US only for now)
  if (s.region && (s.country === "United States" || s.country === "US" || !s.country)) {
    let code = s.region.length === 2 ? s.region.toUpperCase() : REGION_TO_CODE[s.region.toLowerCase()];
    if (code && STATE_TZ[code]) return { tz: STATE_TZ[code], method: "region" };
  }
  // 4. phone → area code → state → tz (full NANP table)
  const phone = s.phone || c.phone;
  if (phone) {
    const m = phone.match(/^\+?1?(\d{3})/);
    if (m) {
      const state = AREA_CODE_STATE[m[1]];
      if (state && STATE_TZ[state]) return { tz: STATE_TZ[state], method: "phone" };
    }
  }
  return { tz: null, method: null };
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  console.log(`Loading staging rows with customer_id resolved...${DRY_RUN ? " (DRY RUN)" : ""}`);
  const staging: StagingRow[] = [];
  let lastId: string | null = null;
  while (true) {
    let q = supabase.from("klaviyo_profile_staging")
      .select("klaviyo_profile_id, customer_id, email, phone, first_name, last_name, address1, address2, city, region, zip, country, timezone")
      .eq("workspace_id", WS)
      .not("customer_id", "is", null)
      .order("klaviyo_profile_id", { ascending: true })
      .limit(1000);
    if (lastId) q = q.gt("klaviyo_profile_id", lastId);
    const { data, error } = await q;
    if (error) throw new Error(`staging fetch: ${error.message}`);
    if (!data || data.length === 0) break;
    staging.push(...(data as StagingRow[]));
    lastId = data[data.length - 1].klaviyo_profile_id;
    if (data.length < 1000) break;
  }
  console.log(`Loaded ${staging.length} resolved staging rows`);

  // For each, fetch customer, run resolver, prepare update
  const stats = {
    tz_klaviyo_direct: 0, tz_zip: 0, tz_zip_state: 0, tz_region: 0, tz_phone: 0,
    tz_already_set: 0, tz_unresolvable: 0,
    addr_filled: 0, addr_already_set: 0,
    name_filled: 0, name_already_set: 0,
  };

  const customerIds = [...new Set(staging.map(s => s.customer_id))];
  const customers = new Map<string, Customer>();
  const CUSTOMER_BATCH = 100;  // 1000 blew the Supabase URL limit
  for (let i = 0; i < customerIds.length; i += CUSTOMER_BATCH) {
    const batch = customerIds.slice(i, i + CUSTOMER_BATCH);
    const { data, error } = await supabase.from("customers")
      .select("id, timezone, default_address, first_name, last_name, phone")
      .in("id", batch);
    if (error) throw new Error(`customer batch fetch ${i}: ${error.message}`);
    for (const c of data || []) customers.set(c.id, c as Customer);
  }
  console.log(`Loaded ${customers.size} customer rows for enrichment`);

  // Build updates per customer
  const updates: Array<{ id: string; timezone?: string; default_address?: object; first_name?: string; last_name?: string }> = [];
  for (const s of staging) {
    const c = customers.get(s.customer_id);
    if (!c) continue;
    const update: { id: string; timezone?: string; default_address?: object; first_name?: string; last_name?: string } = { id: c.id };
    let dirty = false;

    if (!c.timezone) {
      const { tz, method } = resolveTimezone(s, c);
      if (tz) {
        update.timezone = tz;
        dirty = true;
        const key = `tz_${method}` as keyof typeof stats;
        stats[key]++;
      } else {
        stats.tz_unresolvable++;
      }
    } else {
      stats.tz_already_set++;
    }

    if (!c.default_address && (s.address1 || s.city)) {
      update.default_address = {
        address1: s.address1, address2: s.address2,
        city: s.city, province: s.region, zip: s.zip, country: s.country,
      };
      dirty = true;
      stats.addr_filled++;
    } else if (c.default_address) {
      stats.addr_already_set++;
    }

    if (!c.first_name && s.first_name) { update.first_name = s.first_name; dirty = true; stats.name_filled++; }
    else if (c.first_name) stats.name_already_set++;
    if (!c.last_name && s.last_name) { update.last_name = s.last_name; dirty = true; }

    if (dirty) updates.push(update);
  }

  console.log(`\n=== Enrichment summary ===`);
  console.log(`Resolved (about to write):  ${updates.length}`);
  console.log(`Timezone resolution paths:`);
  console.log(`  klaviyo_direct: ${stats.tz_klaviyo_direct}`);
  console.log(`  zip:            ${stats.tz_zip}`);
  console.log(`  zip_state:      ${stats.tz_zip_state}`);
  console.log(`  region:         ${stats.tz_region}`);
  console.log(`  phone:          ${stats.tz_phone}`);
  console.log(`  unresolvable:   ${stats.tz_unresolvable}`);
  console.log(`  already_set:    ${stats.tz_already_set}`);
  console.log(`Address: filled=${stats.addr_filled} already_set=${stats.addr_already_set}`);
  console.log(`Names: filled=${stats.name_filled} already_set=${stats.name_already_set}`);

  if (DRY_RUN) { console.log("\nDRY RUN — no writes performed."); return; }

  // Apply updates (one per customer, batched concurrently)
  let written = 0;
  const t0 = Date.now();
  for (let i = 0; i < updates.length; i += 50) {
    const batch = updates.slice(i, i + 50);
    await Promise.all(batch.map(u => {
      const patch: Record<string, unknown> = {};
      if (u.timezone) patch.timezone = u.timezone;
      if (u.default_address) patch.default_address = u.default_address;
      if (u.first_name) patch.first_name = u.first_name;
      if (u.last_name) patch.last_name = u.last_name;
      patch.updated_at = new Date().toISOString();
      return supabase.from("customers").update(patch).eq("id", u.id);
    }));
    written += batch.length;
    if (i % 1000 === 0) {
      console.log(`  ${written}/${updates.length} customers updated | ${((Date.now()-t0)/60000).toFixed(1)}min`);
    }
  }
  console.log(`\n✓ DONE — customers_updated=${written} time=${((Date.now()-t0)/60000).toFixed(1)}min`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
