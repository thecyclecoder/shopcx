import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const s = await authorSpecRowStructured(WS, "draft-order-country-code-iso2-not-full-name", {
    title: "Draft/replacement orders send the ISO-2 country code ('US'), not the full country name — fixes every US replacement",
    why: "Catherine Green's carrier-lost order SC132896 (Jun 18, $186.20, delivered-scan but nothing arrived — a valid replacement) failed because the draft-order code passes the country NAME 'United States' straight into Shopify's countryCode field, which expects the ISO-2 code 'US'. Only the US territories (PR / GU / VI / AS / MP) get mapped to 'US'; mainland US ('United States') passes through unmapped, so Shopify rejects the draft order — which breaks EVERY US replacement, not just this one. A ticket-improve session caught it on this ticket.",
    what: "The draft-order / replacement shipping address normalizes the country to its ISO-2 code before sending Shopify's countryCode — 'United States' → 'US' (and generally any full country name → its ISO-2 code, with a safe 'US' fallback) — so US replacement draft orders succeed.",
    summary: "**Brain refs:** [[../libraries/replacement-order]] [[../libraries/shopify-draft-orders]] [[../libraries/action-executor]]. **Derived-from-ticket:** SC132896 (Catherine Green — carrier-lost replacement that failed to create). Grounded in: src/lib/shopify-draft-orders.ts:183 (`countryCode: [PR,GU,VI,AS,MP].includes(country) ? 'US' : country` — mainland 'United States' passes through as the countryCode) and :316 (`countryCode: addr.country || addr.country_code || 'US'` — same). Shopify's countryCode is ISO-2; the full name breaks the draft.",
    owner: "cs",
    parent: '[[../functions/cs]] — "Ticket-derived product fixes" mandate: a bug a real ticket surfaced (SC132896) — draft/replacement orders must send the ISO-2 country code Shopify expects, so US replacements stop failing.',
    blocked_by: [],
    phases: [
      { title: "Phase 1 — normalize country to ISO-2 in the draft-order path",
        why: "Shopify's countryCode is ISO-2; passing the full name 'United States' breaks the draft — and it silently breaks every US replacement, not just the ticket that surfaced it.",
        what: "Before sending Shopify's countryCode, normalize the shipping address country to its ISO-2 code — 'United States' → 'US', and any full country name → its ISO-2 — with a safe 'US' fallback.",
        body: "In src/lib/shopify-draft-orders.ts, fix both countryCode sites (~:183 and ~:316) to normalize the country to ISO-2 rather than passing the raw name. Map 'United States'/'USA'/'US' → 'US' (fold the existing PR/GU/VI/AS/MP → 'US' territory mapping into the same normalizer) and, for non-US, map the full name → ISO-2 (a small name→ISO2 table or an existing helper) with a 'US' fallback. Apply the same normalization anywhere the replacement path builds a Shopify shipping address ([[../libraries/replacement-order]]). Cite the two countryCode sites.",
        verification: "A US replacement draft order (country 'United States') creates successfully — countryCode sent as 'US', not 'United States' (regression pin for SC132896). A territory (PR) still maps to 'US'. A non-US country maps to its ISO-2. A missing country falls back to 'US'. No draft-order path sends a full country name as countryCode.",
        status: "planned" },
    ],
  }, "planned", { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "cs#ticket-derived" });
  console.log("countryCode spec:", s?"authored":"FAILED");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("ERR",e.message||e);process.exit(1);});
