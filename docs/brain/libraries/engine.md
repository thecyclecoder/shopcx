# libraries/engine

The shared engine: pure logic that ShopCX and ShopGrowth (shopgrowth.ai, the Shopify App Store business) both run on. Data in, verdict out. No database, network, secrets, clock, or anything specific to either business.

**Folder:** `src/lib/engine/` · **Entry:** `src/lib/engine/index.ts` (`ENGINE_VERSION`) · **Fraud:** `src/lib/engine/fraud/index.ts`

## What's in it

| File | Exports | Notes |
|---|---|---|
| `fraud/freemail.ts` + `freemail-domains.json` | `FREEMAIL_DOMAINS`, `emailDomain`, `isCustomDomain` | Vendored ~12.3k-domain list (moved from `src/lib/`). Exclusion set for every custom-domain signal. |
| `fraud/names.ts` | `firstNameOverlap`, `normalizeNameTokens`, `cardBillingNamesAgree`, `surnameOf`, `isAvsOrCvvFailure` | Name normalizers used by BIN velocity and repeat-offender matching. |
| `fraud/bin-cluster.ts` | `evaluateBinCluster`, `applyDismissalSuppression`, BIN thresholds, `VELOCITY_WINDOW_DAYS` | Moved verbatim from [[fraud-detector]]. Tests: `npm run test:fraud-bin-velocity` (Sep-2026 bin:414740). |
| `fraud/velocity.ts` | `evaluateDomainVelocity`, `evaluateSurnameVelocity`, their thresholds | Threshold + wording decisions of the domain/surname velocity branches. Tests: `npm run test:engine-fraud-velocity` (@netscape.net, throwaway domain, Reinard-shaped surname ring). |

Signals whose logic was already pure were **moved** (ShopCX imports them back, behavior identical; `fraud-detector.ts` re-exports `evaluateBinCluster` / `applyDismissalSuppression` for existing importers). Signals still tangled with DB/AI calls get **copied** into the engine next, so the legacy path stays the parity oracle for the shadow run.

## Why

ShopGrowth sells ShopCX technology (first app: Interceptor by ShopGrowth, fraud and reseller screening) to other Shopify merchants without any merchant ever touching ShopCX. The rule is one engine, two businesses: a fix or new rule lands once, here, with tests; each business wires it to its own data, jobs, and actions. ShopCX keeps its DB writes, Shopify tagging, Inngest events, heartbeats, and kill switches in its own wiring outside this folder.

## Purity rail

`scripts/_check-engine-purity.ts` (`npm run check:engine-purity`, in `predeploy:static`; tests: `npm run test:engine-purity`) fails if any non-test file under `src/lib/engine/`:
- imports ShopCX code (`@/...`) or a relative path outside the folder,
- imports a package not on `ALLOWED_PACKAGES` (currently `zipcodes`),
- reads `process.env`, calls `fetch`, `Date.now()`, `new Date()` (no args) or `Math.random()`.

Callers pass `now`, config, and data in. AI calls go through an injected function the caller supplies (its own client and key); the engine owns only prompts and answer parsing.

## Roadmap (fraud first)

1. **Phase 0 (this page):** folder + purity rail. No behavior change.
2. **Phase 1 (in progress — velocity signals done):** copy (not move) fraud logic from [[fraud-detector]] into `src/lib/engine/fraud/`: normalizers ([[address-normalize]], `normalizeReseller`, freemail list), per-signal evaluators (address distance, name mismatch, repeat-offender matches, `evaluateBinCluster`, domain/surname velocity, shared-address classification, reseller prefilter), prompt builders/parsers, and `screenOrder(input, readPorts, config)` returning a verdict (findings, plain-language reasons, orders to hold). Tests from real incidents (Reinard ring, BIN 414740, `@netscape.net`, 7704 Romaine St, 10083 Lynden Oval).
3. **Phase 2:** shadow run inside `checkOrderForFraud`: legacy stays authoritative, engine verdicts are diffed and recorded (replaying the legacy AI answers, so no extra Haiku calls).
4. **Phase 3:** read-only replay over historical orders for rare signals; prove JS grouping matches the `fraud_detect_shared_addresses` / `fraud_detect_high_velocity` RPCs.
5. **Phase 4:** per-signal cutover; legacy matchers deleted after one release.
6. **Phase 5:** lift the folder verbatim into its own private repo as a versioned package; ShopCX pins an exact version.

Full plan (incl. the five legacy quirks the shadow must reproduce before they're fixed): `thecyclecoder/shopgrowth` → `docs/plans/engine-extraction-plan.md`.

## Callers

- [[fraud-detector]] `checkVelocitySignals` — BIN, email-domain and surname velocity decisions; repeat-offender `same_email_domain` / `fuzzy_name` matches use `FREEMAIL_DOMAINS` / `firstNameOverlap`.

## Related

[[fraud-detector]] · [[address-normalize]] · [[fraud-confirm]] · [[../lifecycles/fraud-detection]]
