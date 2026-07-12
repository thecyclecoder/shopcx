# libraries/spec-check-db-probes

Constrained registry of READ-ONLY DB probes callable from a machine-declared verification check (`spec_phase_checks.exec_kind = 'db_probe_readonly'`). Closes the pre-merge Vault findings on the old free-form `params.sql` executor ([[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] Phase 4): the runner NEVER executes spec-authored SQL — a check names a probe by id from a fixed allowlist here, and the executor invokes the probe's shaped query.

**File:** `src/lib/spec-check-db-probes.ts` — exports `DB_PROBES`, `isRegisteredProbe`, `listRegisteredProbes`, `containsSensitiveColumn`, `SENSITIVE_COLUMN_PATTERN`, `assertRegistryInvariants` and the `DbProbeDefinition` / `DbProbeArg` / `DbProbeArgs` / `DbProbeRun` types.

## The 5 findings this registry closes

Vault flagged five HIGH findings against the previous `spec-check-runner.ts` `db_probe_readonly` executor (spec-check-runner.ts:320/325/332). Every one traces to the same root — free-form spec-authored SQL executed on a service-role admin client, with raw response data serialized into evidence:

| Finding | What the free-form path exposed | How the registry closes it |
|---|---|---|
| `injection` | `validateExecutableCheck` accepted any SELECT/WITH; `exec_readonly_sql` ran the spec-authored string | Only registered probes run; validator + runner both reject unknown ids |
| `secret_leak` | Mismatch path serialized returned rows into evidence | Evidence is the probe's REDACTED string (probe id + scalar), never a row body |
| `authz_rls` | `createAdminClient()` ran the caller SELECT without workspace scoping | `requiresWorkspaceId: true` probes MUST bind `workspace_id` via `.eq()`; asserted by `assertRegistryInvariants` |
| `unsafe_admin_client` | Service-role read power reachable from spec-authored payload | Registry adds a code-review chokepoint; nothing else touches admin |
| `crypto_encrypted` | `SELECT * FROM …_encrypted` was a valid payload | `containsSensitiveColumn` denylist on arg names + probes never `.select()` `*_encrypted` columns |

## Contract

```ts
type DbProbeArg = string | number | boolean;
type DbProbeArgs = Record<string, DbProbeArg>;

interface DbProbeRun {
  value: number | boolean | null;   // scalar the check's `expect` is deep-equal-compared to
  evidence: string;                  // REDACTED — probe id + arg summary + scalar, never a row body
}

interface DbProbeDefinition {
  description: string;
  requiredArgs: readonly string[];
  requiresWorkspaceId: boolean;      // enforces workspace_id in requiredArgs
  run(admin: SupabaseClient, args: DbProbeArgs): Promise<DbProbeRun>;
}
```

## Invariants (asserted at load time via `assertRegistryInvariants`)

1. **Tenant scoping.** Every probe with `requiresWorkspaceId: true` MUST list `workspace_id` in `requiredArgs`. Enforced by `assertRegistryInvariants`; a violation throws at module-load time.
2. **No sensitive arg names.** No `requiredArgs` entry may match `SENSITIVE_COLUMN_PATTERN` (`*_encrypted`, `secret_*`, `api_key`, `private_key`, `*_token`). Belt-and-suspenders even though bind values are scalars — a match at the arg level rejects at authoring, not at runtime.
3. **Scalar `value`.** `run` returns `number | boolean | null` only — the runner deep-equals it to `expect`. A probe that needs to expose a row's shape returns a count / exists / hash summary, never the row.
4. **Redacted `evidence`.** The evidence string names the probe id + args used + the scalar value; it must NEVER be a JSON.stringify of the admin query response (that was the secret_leak surface).
5. **`.eq()` binding.** Args reach the DB via parameterized client methods (`.eq()`, `.in()`, `.limit()`), never a template-string splice. That is what prevents SQL injection from arg values.

## Adding a probe

Every new probe is a security decision: a code review of `src/lib/spec-check-db-probes.ts` + a unit test. Land the probe in `DB_PROBES`, add a test in `src/lib/spec-check-db-probes.test.ts` that asserts the shaped call + the redacted evidence, and update this page. The [[spec-check-runner]] executor + the [[spec-phase-checks-executable]] validator both consume the registry — nothing else needs to change.

**When NOT to add one.** Most verification bullets should stay `grep` / `http_get` / `tsc` / `unit_test` / `build` — those need no DB access. A probe is only justified when a bullet cannot otherwise assert the state (e.g. "the folded spec's row exists"). During the migration window, prefer `needs_human` over authoring a new probe on a hunch.

## Registered probes (as of this build)

| id | description | requiredArgs | requiresWorkspaceId |
|---|---|---|---|
| `spec_exists_by_slug` | true iff a spec row exists for (workspace_id, slug) | workspace_id, slug | true |
| `spec_phase_checks_count_for_slug` | count of `spec_phase_checks` rows for a spec | workspace_id, slug | true |

## Related

[[spec-check-runner]] · [[spec-phase-checks-table]] · [[spec-phase-checks-executable]] · [[../specs/machine-declared-verification-and-deterministic-spec-test-runner]]
