import { test } from "node:test";
import assert from "node:assert/strict";
import { adMatchesCompetitor, hostOf, registrableDomain } from "./adlibrary";

// The scout relevance filter (CEO 2026-07-12): brand-keyword search on AdLibrary is noisy — it returns
// wrong-brand ads ("Bulletproof" → "Bulletproof Automotive" car wheels) and content-matches ("Four Sigmatic"
// → "Neubrain"). adMatchesCompetitor keeps only ads that actually belong to the intended competitor:
// domain-match is authoritative when a domain is determinable; exact advertiser-name match is the fallback
// only when the ad has no determinable domain (opaque `ar…` id + null landing page).

test("hostOf: strips protocol/www/path, returns null for opaque ids", () => {
  assert.equal(hostOf("https://www.bulletproofautomotive.com/x?y=1"), "bulletproofautomotive.com");
  assert.equal(hostOf("shop.bulletproof.com"), "shop.bulletproof.com");
  assert.equal(hostOf("ar04757606072020107265"), null); // AdLibrary opaque ecom_advertiser_id
  assert.equal(hostOf(null), null);
});

test("registrableDomain: collapses subdomains to eTLD+1", () => {
  assert.equal(registrableDomain("shop.bulletproof.com"), "bulletproof.com");
  assert.equal(registrableDomain("bulletproofautomotive.com"), "bulletproofautomotive.com");
  assert.equal(registrableDomain("mudwtr.com"), "mudwtr.com");
});

test("domain-match is authoritative: rejects wrong-brand with a SIMILAR name", () => {
  // The exact bug: searching "Bulletproof" returned the car-wheel company. Its landing page is a
  // DIFFERENT registrable domain, so it's rejected even though the name shares the "bulletproof" prefix.
  assert.equal(
    adMatchesCompetitor(
      { advertiser: "Bulletproof Automotive", destination_domain: "ar04757606072020107265", landing_page_url: "https://www.bulletproofautomotive.com" },
      { domain: "bulletproof.com", advertiser: "Bulletproof" },
    ),
    false,
  );
  // The real Bulletproof coffee brand drives to shop.bulletproof.com → accepted.
  assert.equal(
    adMatchesCompetitor(
      { advertiser: "Bulletproof", destination_domain: "shop.bulletproof.com", landing_page_url: null },
      { domain: "bulletproof.com", advertiser: "Bulletproof" },
    ),
    true,
  );
});

test("rejects content-match / affiliate on a different domain", () => {
  // "Four Sigmatic" keyword surfaced Neubrain (a content-match) on drinkneubrain.com → rejected.
  assert.equal(
    adMatchesCompetitor(
      { advertiser: "Neubrain", destination_domain: "drinkneubrain.com", landing_page_url: null },
      { domain: "foursigmatic.com", advertiser: "Four Sigmatic" },
    ),
    false,
  );
  // Affiliate page fronting Erth Labs under its own name/domain → rejected (we want the brand's OWN ads).
  assert.equal(
    adMatchesCompetitor(
      { advertiser: "Holistic Health Finds", destination_domain: null, landing_page_url: "https://holistichealthfinds.com/x" },
      { domain: "erthlabs.co", advertiser: "Erth Labs" },
    ),
    false,
  );
});

test("advertiser fallback: rescues the real brand when the ad has an opaque destination", () => {
  // "Mud Wtr, Inc" ad with an opaque `ar…` destination + null landing → no determinable domain, so the
  // exact advertiser-name fallback accepts it.
  assert.equal(
    adMatchesCompetitor(
      { advertiser: "Mud Wtr, Inc", destination_domain: "ar16982448538338197505", landing_page_url: null },
      { domain: "mudwtr.com", advertiser: "Mud Wtr, Inc" },
    ),
    true,
  );
  // A junk tool ad ("Konvert" → staticflow.io) with a determinable domain that doesn't match → rejected
  // (the fallback never runs because a domain IS determinable).
  assert.equal(
    adMatchesCompetitor(
      { advertiser: "Konvert", destination_domain: null, landing_page_url: "http://www.staticflow.io/templates" },
      { domain: "mudwtr.com", advertiser: "Mud Wtr, Inc" },
    ),
    false,
  );
});

test("no expected domain AND no determinable ad domain AND no name match → reject (don't pollute)", () => {
  assert.equal(
    adMatchesCompetitor(
      { advertiser: "Some Random Brand", destination_domain: "ar999", landing_page_url: null },
      { domain: null, advertiser: "Mud Wtr, Inc" },
    ),
    false,
  );
});
