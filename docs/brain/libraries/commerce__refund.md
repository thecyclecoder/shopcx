# libraries/commerce__refund

Refund issuance mutation in the Commerce SDK.

**File:** `src/lib/commerce/refund.ts`

**Status:** Phase 1 surface declared (Phase 1 complete). Implementations arrive in M2c per [[../reference/commerce-sdk-inventory.html]].

## Design notes (Phase 2)

Refund money moves through a gateway (`'braintree' | 'shopify'`) — that discriminator is declared on the Gateway union added by Phase 4. The Mutation op MUST resolve cents through `./price.ts`, never a caller-supplied number, so the phantom-refund defect (defect register #1 in [[../reference/commerce-sdk-inventory.html]]) cannot recur.

## Migration (Phase 2 in-flight)

Phase 2 moves `refundOrder` from [[../libraries/refund]] (built in returns-refund-internal-aware-dispatcher) into this SDK module, with a @deprecated shim left in the old location for M4/M5 migration.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure, Phase sequencing, and defect register.
[[../libraries/refund]] — Legacy refund module (now deprecated in favor of commerce SDK).
[[./price]] — Price resolver (used for all refund amount calculations).
[[./types]] — Commerce SDK type definitions.
