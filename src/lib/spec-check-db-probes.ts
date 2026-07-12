/**
 * spec-check-db-probes — constrained registry of READ-ONLY DB probes callable from a
 * machine-declared verification check (spec_phase_checks.exec_kind = 'db_probe_readonly').
 *
 * Closes the 5 pre-merge Vault findings on the free-form `params.sql` path
 * (spec-check-runner.ts:320/325/332 — injection · secret_leak · authz_rls ·
 * unsafe_admin_client · crypto_encrypted). A spec-authored check now names a probe by id
 * from a fixed allowlist here; the executor NEVER runs user-controlled SQL, workspace_id
 * is a required bound arg where applicable, and evidence is redacted (a count/bool +
 * the probe id, never a raw row body).
 *
 * Adding a probe = a code review of THIS file + a unit test. That is the whole point:
 * spec-test cannot smuggle read-access to `*_encrypted` / secret columns through a
 * verification payload, only through a merged capability.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Probe args are bound as scalars only — never a subquery, never a column list. */
export type DbProbeArg = string | number | boolean;
export type DbProbeArgs = Record<string, DbProbeArg>;

/**
 * A probe returns a small scalar + a redacted human evidence string. The caller compares
 * `value` to the check's `expect` — the runner NEVER stringifies the raw admin query
 * response into evidence (that was the crypto_encrypted / secret_leak surface).
 */
export interface DbProbeRun {
  /** Scalar the check's `expect` is compared to. Numbers / booleans / null only. */
  value: number | boolean | null;
  /** Redacted evidence — the probe id + arg summary + the scalar. Never a row body. */
  evidence: string;
}

export interface DbProbeDefinition {
  /** Human summary shown in evidence / documentation. */
  description: string;
  /** Required arg names (each must be present + typed as scalar). */
  requiredArgs: readonly string[];
  /**
   * True → `workspace_id` MUST appear in requiredArgs AND MUST be bound via `.eq()` in `run`.
   * The registry validator asserts this at load time so a mistakenly-unscoped probe cannot
   * ship (the authz_rls fix — a service-role admin client is only safe when tenant-scoped
   * explicitly).
   */
  requiresWorkspaceId: boolean;
  /**
   * Executes the shaped query on the pooled admin client and returns the redacted result.
   * The registry — not the caller — owns the SQL. NEVER splice `args` into a template
   * string; use only the client's `.eq()` / `.limit()` etc. (parameterized).
   */
  run: (admin: SupabaseClient, args: DbProbeArgs) => Promise<DbProbeRun>;
}

/**
 * Sensitive column-name pattern — a defense-in-depth denylist for arg names AND for any
 * .select() a future probe author writes. Never allow a spec-authored arg to reach a
 * column whose name looks like a secret / encrypted credential.
 */
export const SENSITIVE_COLUMN_PATTERN = /(_encrypted$|_secret$|(^|_)secret(_|$)|(^|_)api_key(_|$)|(^|_)private_key(_|$)|(^|_)token(_|$))/i;
export function containsSensitiveColumn(name: string): boolean {
  return SENSITIVE_COLUMN_PATTERN.test(name);
}

/**
 * The allowlist. Every entry is code-reviewed; nothing on this list may `.select()` a
 * `*_encrypted` / `*_secret` / token column, and every probe that touches a tenant-scoped
 * table must set `requiresWorkspaceId: true` and bind it via `.eq('workspace_id', ...)`.
 *
 * Kept intentionally tiny: verification bullets that need something more than
 * grep / http_get / tsc / unit_test / build should overwhelmingly land as `needs_human`
 * during the migration window; adding a probe is a security decision.
 */
export const DB_PROBES: Record<string, DbProbeDefinition> = {
  /**
   * True iff a spec row exists for (workspace_id, slug). Reads a single non-secret
   * column (`id`) — the shaped result is a boolean, so evidence never carries body data.
   * Useful for a spec whose verification includes "the spec row for X still exists".
   */
  spec_exists_by_slug: {
    description: "true iff a spec row exists for (workspace_id, slug)",
    requiredArgs: ["workspace_id", "slug"],
    requiresWorkspaceId: true,
    run: async (admin, args) => {
      const workspaceId = String(args.workspace_id);
      const slug = String(args.slug);
      const { data, error } = await admin
        .from("specs")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const value = Boolean(data);
      return {
        value,
        evidence: `probe spec_exists_by_slug(slug=${slug}) → ${value}`,
      };
    },
  },

  /**
   * Count of `spec_phase_checks` rows for a spec. Reads a single column (`id`) with a
   * `count: exact` head request — the response body is a count, never a row. Useful for
   * asserting "every phase carries ≥N checks".
   */
  spec_phase_checks_count_for_slug: {
    description: "count of spec_phase_checks rows for a spec by (workspace_id, slug)",
    requiredArgs: ["workspace_id", "slug"],
    requiresWorkspaceId: true,
    run: async (admin, args) => {
      const workspaceId = String(args.workspace_id);
      const slug = String(args.slug);
      const { data: spec, error: se } = await admin
        .from("specs")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("slug", slug)
        .maybeSingle();
      if (se) throw new Error(se.message);
      if (!spec) {
        return {
          value: 0,
          evidence: `probe spec_phase_checks_count_for_slug(slug=${slug}) → no spec, count=0`,
        };
      }
      const { data: phases, error: pe } = await admin
        .from("spec_phases")
        .select("id")
        .eq("spec_id", (spec as { id: string }).id);
      if (pe) throw new Error(pe.message);
      const phaseIds = ((phases as { id: string }[]) ?? []).map((p) => p.id);
      if (!phaseIds.length) {
        return {
          value: 0,
          evidence: `probe spec_phase_checks_count_for_slug(slug=${slug}) → no phases, count=0`,
        };
      }
      const { count, error: ce } = await admin
        .from("spec_phase_checks")
        .select("id", { count: "exact", head: true })
        .in("phase_id", phaseIds);
      if (ce) throw new Error(ce.message);
      const value = count ?? 0;
      return {
        value,
        evidence: `probe spec_phase_checks_count_for_slug(slug=${slug}) → count=${value}`,
      };
    },
  },
};

export function isRegisteredProbe(probeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(DB_PROBES, probeId);
}

/** Registry names — cheap listing for authoring UI / error messages. */
export function listRegisteredProbes(): string[] {
  return Object.keys(DB_PROBES);
}

/**
 * Load-time invariants — asserted once so a bad probe cannot ship silently. Called by the
 * unit test; also cheap enough to run at module import time.
 */
export function assertRegistryInvariants(): void {
  for (const [id, def] of Object.entries(DB_PROBES)) {
    if (def.requiresWorkspaceId && !def.requiredArgs.includes("workspace_id")) {
      throw new Error(
        `spec-check-db-probes: probe '${id}' declares requiresWorkspaceId=true but does not list 'workspace_id' in requiredArgs`,
      );
    }
    for (const arg of def.requiredArgs) {
      if (containsSensitiveColumn(arg)) {
        throw new Error(
          `spec-check-db-probes: probe '${id}' declares a sensitive-looking required arg name '${arg}' (denylisted)`,
        );
      }
    }
  }
}
