# Security dependency upgrades

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/security-dependency-agent]] · auto-authored by [[../libraries/security-agent]].
**Dep-advisory-signature:** `e744eed370f1`

The daily `npm audit` dep-watch found 48 actionable advisory(ies) (≥ moderate). Bump the affected dependencies to their fixed versions. NEVER auto-bumped — this owner-gated build does the bump + the `tsc` gate.

## Phase 1 — upgrade the vulnerable dependencies
- **protobufjs** (critical) — Arbitrary code execution in protobufjs. Upgrade → available
- **@grpc/grpc-js** (high) — @grpc/grpc-js: A malformed request can cause a server crash. Upgrade → available
- **@opentelemetry/auto-instrumentations-node** (high) — Prometheus exporter process crash via malformed HTTP request. Upgrade → available
- **@opentelemetry/exporter-prometheus** (high) — Prometheus exporter process crash via malformed HTTP request. Upgrade → available
- **@opentelemetry/sdk-node** (high) — Prometheus exporter process crash via malformed HTTP request. Upgrade → available
- **@remotion/bundler** (high) — @remotion/bundler 4.0.90 - 4.0.478. Upgrade → available
- **@remotion/cli** (high) — @remotion/cli 3.0.24 - 4.0.478 || >=4.1.0-alpha1. Upgrade → available
- **@remotion/lambda** (high) — @remotion/lambda 3.0.24 - 4.0.478 || >=4.1.0-alpha10. Upgrade → available
- **@remotion/renderer** (high) — @remotion/renderer 3.0.24 - 4.0.478 || >=4.1.0-alpha1. Upgrade → available
- **@remotion/serverless** (high) — @remotion/serverless <=4.0.478. Upgrade → available
- **@remotion/studio** (high) — @remotion/studio <=4.0.478. Upgrade → available
- **@remotion/studio-server** (high) — @remotion/studio-server <=4.0.478. Upgrade → available
- **form-data** (high) — form-data: CRLF injection in form-data via unescaped multipart field names and filenames. Upgrade → available
- **hono** (high) — hono: Path traversal in `serve-static` on Windows via encoded backslash (`%5C`). Upgrade → available
- **next** (high) — Next.js has a Denial of Service with Server Components. Upgrade → next@16.2.9
- **picomatch** (high) — Picomatch: Method Injection in POSIX Character Classes causes incorrect Glob Matching. Upgrade → available
- **ws** (high) — ws: Memory exhaustion DoS from tiny fragments and data chunks. Upgrade → available
- **@opentelemetry/configuration** (moderate) — @opentelemetry/configuration <=0.218.0. Upgrade → available
- **@opentelemetry/core** (moderate) — OpenTelemetry Core: Unbounded memory allocation in W3C Baggage propagation. Upgrade → available
- **@opentelemetry/exporter-logs-otlp-grpc** (moderate) — @opentelemetry/exporter-logs-otlp-grpc <=0.218.0. Upgrade → available
- **@opentelemetry/exporter-logs-otlp-http** (moderate) — @opentelemetry/exporter-logs-otlp-http <=0.218.0. Upgrade → available
- **@opentelemetry/exporter-logs-otlp-proto** (moderate) — @opentelemetry/exporter-logs-otlp-proto <=0.218.0. Upgrade → available
- **@opentelemetry/exporter-metrics-otlp-grpc** (moderate) — @opentelemetry/exporter-metrics-otlp-grpc <=0.218.0. Upgrade → available
- **@opentelemetry/exporter-metrics-otlp-http** (moderate) — @opentelemetry/exporter-metrics-otlp-http <=0.218.0. Upgrade → available
- **@opentelemetry/exporter-metrics-otlp-proto** (moderate) — @opentelemetry/exporter-metrics-otlp-proto <=0.218.0. Upgrade → available
- **@opentelemetry/exporter-trace-otlp-grpc** (moderate) — @opentelemetry/exporter-trace-otlp-grpc <=0.218.0. Upgrade → available
- **@opentelemetry/exporter-trace-otlp-http** (moderate) — @opentelemetry/exporter-trace-otlp-http <=0.218.0. Upgrade → available
- **@opentelemetry/exporter-trace-otlp-proto** (moderate) — @opentelemetry/exporter-trace-otlp-proto <=0.218.0. Upgrade → available
- **@opentelemetry/exporter-zipkin** (moderate) — @opentelemetry/exporter-zipkin <=2.7.1. Upgrade → available
- **@opentelemetry/instrumentation-http** (moderate) — @opentelemetry/instrumentation-http <=0.16.0 || 0.19.1-alpha.7 - 0.218.0. Upgrade → available
- **@opentelemetry/otlp-exporter-base** (moderate) — @opentelemetry/otlp-exporter-base <=0.218.0. Upgrade → available
- **@opentelemetry/otlp-grpc-exporter-base** (moderate) — @opentelemetry/otlp-grpc-exporter-base <=0.218.0. Upgrade → available
- **@opentelemetry/otlp-transformer** (moderate) — @opentelemetry/otlp-transformer <=0.218.0. Upgrade → available
- **@opentelemetry/propagator-b3** (moderate) — @opentelemetry/propagator-b3 0.19.1-alpha.11 - 2.7.1. Upgrade → available
- **@opentelemetry/propagator-jaeger** (moderate) — @opentelemetry/propagator-jaeger 0.5.0 - 2.7.1. Upgrade → available
- **@opentelemetry/resources** (moderate) — @opentelemetry/resources 0.8.0 - 2.7.1. Upgrade → available
- **@opentelemetry/sdk-logs** (moderate) — @opentelemetry/sdk-logs <=0.218.0. Upgrade → available
- **@opentelemetry/sdk-metrics** (moderate) — @opentelemetry/sdk-metrics <=2.7.1. Upgrade → available
- **@opentelemetry/sdk-trace-base** (moderate) — @opentelemetry/sdk-trace-base <=2.7.1. Upgrade → available
- **@opentelemetry/sdk-trace-node** (moderate) — @opentelemetry/sdk-trace-node <=2.7.1. Upgrade → available
- **@protobufjs/utf8** (moderate) — protobufjs has overlong UTF-8 decoding. Upgrade → available
- **brace-expansion** (moderate) — brace-expansion: Zero-step sequence causes process hang and memory exhaustion. Upgrade → available
- **js-yaml** (moderate) — JS-YAML: Quadratic-complexity DoS in merge key handling via repeated aliases. Upgrade → available
- **postcss** (moderate) — PostCSS has XSS via Unescaped </style> in its CSS Stringify Output. Upgrade → next@16.2.9
- **qs** (moderate) — qs has a remotely triggerable DoS: qs.stringify crashes with TypeError on null/undefined entries in comma-format arrays when encodeValuesOnly is set. Upgrade → available
- **resend** (moderate) — resend 6.2.0-canary.0 - 6.12.2. Upgrade → available
- **svix** (moderate) — svix 1.68.0 - 1.91.1. Upgrade → available
- **uuid** (moderate) — uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided. Upgrade → available

Apply the upgrades (e.g. `npm audit fix`, or bump each in package.json + `npm install`), then gate on `npx tsc --noEmit` and a smoke of any affected path. Flag any semver-major bump for human review before merge.

## Verification
- Re-run `npm audit` → expect the flagged advisory(ies) no longer appear (or are downgraded below moderate).
- `npx tsc --noEmit` is clean after the bumps.

> Authored by the box Security Agent (Vault). Read-only watch; the owner-gated build applies the bump.
