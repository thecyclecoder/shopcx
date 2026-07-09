/**
 * Sol's OPTIONAL "propose a code-fix spec" output on a portal-error ticket.
 *
 * Phase 2 of [[../../../docs/brain/specs/portal-errors-route-to-sol-first-escalate-to-june-on-rail]].
 * Dual output: Sol ALWAYS produces the customer-facing remediation; ADDITIONALLY, when she judges the
 * portal error has a structural code cause (not a one-off / self-inflicted state), she returns a
 * `proposed_spec` field in the same ticket-handle JSON. The worker (deterministic Node — the only
 * mutator) authors the spec on the Roadmap through the existing CS ticket-derived-product-fixes path
 * ([[../improve-plan-executor]]'s pattern), owner=`cs`, Derived-from-ticket ref, autoBuild=false so
 * it lands `planned` on the board rather than auto-building. A one-off portal error yields no
 * `proposed_spec` and no spec noise.
 *
 * This module is split into pure helpers (validated / summary + phase build / author-spec input
 * assembly) plus the impure wrapper `authorSolProposedPortalErrorSpec` that hits `authorSpecRowStructured`.
 * The pure helpers are what the unit test exercises — the wire-in to `runTicketHandleJob` calls the
 * impure wrapper. See [[./enqueue-sol-first-touch]] (Phase 1) and [[../ticket-directions]] (the M1
 * Direction SDK the same JSON drives).
 */
import type { StructuredSpecInput, StructuredPhaseInput, AuthorSpecOpts, AutoAnchorResult } from "@/lib/author-spec";
import type { FunctionMandate } from "@/lib/function-mandates";

/** The exact shape Sol returns under `proposed_spec` in her ticket-handle JSON. */
export interface SolProposedSpec {
  /** kebab-case slug for the roadmap row (`public.specs.slug`). Sanitized to `[a-z0-9-]`. */
  slug: string;
  /** Board title (`public.specs.title`). */
  title: string;
  /** Plain-language WHY / customer intent that will feed the spec's `why`. */
  intent: string;
  /** Plain-language PROBLEM description that describes the structural code cause. */
  problem: string;
  /** Optional CS-function mandate the spec attaches under; unknown / omitted → chokepoint auto-anchors. */
  mandate?: string | null;
}

/**
 * Validate + normalize Sol's raw `proposed_spec` field. Returns null when required fields are
 * missing/blank — that is the "one-off portal error → no spec noise" branch. Same defensive shape
 * `runTicketHandleJob` already uses on the top-level Direction fields (learning #1: re-assert the
 * write-time invariant BEFORE mutating). Kebab-case sanitization mirrors [[../improve-plan-executor]]
 * `ticketSpecFields`.
 */
export function validateSolProposedSpec(raw: unknown): SolProposedSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const slugRaw = typeof r.slug === "string" ? r.slug : "";
  const slug = slugRaw.replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const intent = typeof r.intent === "string" ? r.intent.trim() : "";
  const problem = typeof r.problem === "string" ? r.problem.trim() : "";
  if (!slug || !title || !intent || !problem) return null;
  const mandate = typeof r.mandate === "string" && r.mandate.trim().length ? r.mandate.trim() : null;
  return { slug, title, intent, problem, mandate };
}

/** Build the roadmap-visible summary + phase body + verification for a ticket-derived portal-error
 *  spec. Same anchor shape [[../improve-plan-executor]] `ticketSpecFields` uses so a Roadmap consumer
 *  reads one consistent "**Derived-from-ticket:** `<id>`" line regardless of which surface authored. */
export function buildPortalErrorSpecFields(
  spec: Pick<SolProposedSpec, "intent" | "problem">,
  ticketId: string,
): { summary: string; phaseBody: string; phaseVerification: string } {
  const summary = [
    `**Derived-from-ticket:** \`${ticketId}\``,
    ``,
    spec.intent,
    ``,
    `## Problem (from portal-error ticket \`${ticketId}\`)`,
    spec.problem,
    ``,
    `> Authored by Sol on a portal-error first-touch session — commission the build from the Roadmap board (owner = cs).`,
  ].join("\n");
  const phaseBody = [
    `Implement the fix scoped from the problem above.`,
    ``,
    `Land the code change + the matching brain page in the SAME PR (CLAUDE.md hard rule).`,
  ].join("\n");
  const phaseVerification = `Reproduce the portal error path → confirm the fixed behavior, and that the ticket that surfaced it (\`${ticketId}\`) would now be handled correctly. \`npx tsc --noEmit\` clean.`;
  return { summary, phaseBody, phaseVerification };
}

/** The exact args `authorSpecRowStructured` will receive — kept as a pure builder so the unit test
 *  can assert the roadmap shape (owner=cs, autoBuild=false, Derived-from-ticket ref, parent anchoring)
 *  without touching the DB. */
export function buildAuthorSpecArgs(
  ticketId: string,
  spec: SolProposedSpec,
  csMandates: FunctionMandate[],
): {
  slug: string;
  input: StructuredSpecInput;
  opts: Pick<AuthorSpecOpts, "intendedStatusSetBy" | "parentKind" | "parentRef" | "onAutoAnchor">;
  matchedMandate: FunctionMandate | null;
} {
  const { summary, phaseBody, phaseVerification } = buildPortalErrorSpecFields(spec, ticketId);
  const llmPickedRaw = (spec.mandate || "").trim().toLowerCase();
  const matchedMandate = llmPickedRaw ? csMandates.find((m) => m.slug === llmPickedRaw) ?? null : null;
  const authoredParent = matchedMandate
    ? `[[../functions/cs#${matchedMandate.slug}]] — "${matchedMandate.heading}" mandate: ${spec.title}.`
    : `[[../functions/cs]]`;
  const parentKind: AuthorSpecOpts["parentKind"] = matchedMandate ? "mandate" : null;
  const parentRef: AuthorSpecOpts["parentRef"] = matchedMandate ? `cs#${matchedMandate.slug}` : null;
  const phase: StructuredPhaseInput = {
    title: `P1 — implement the fix`,
    body: phaseBody,
    verification: phaseVerification,
    status: "planned",
    why: `Portal-error ticket ${ticketId} surfaces a structural code cause that requires a durable spec fix commissioned on the Roadmap.`,
    what: `When this phase ships, the portal error identified in ticket ${ticketId} is fixed at its structural source.`,
  };
  const input: StructuredSpecInput = {
    title: spec.title,
    summary,
    owner: "cs",
    parent: authoredParent,
    blocked_by: [],
    autoBuild: false, // land planned on the Roadmap — the human commissions the build.
    phases: [phase],
    why: `Portal-error ticket ${ticketId} identified a structural code cause requiring a spec fix commissioned on the Roadmap.`,
    what: `When this spec ships, the portal error surfaced by ticket ${ticketId} is prevented at its source rather than remediated case-by-case by Sol.`,
  };
  return {
    slug: spec.slug,
    input,
    opts: {
      intendedStatusSetBy: "box:sol-ticket-handle",
      parentKind,
      parentRef,
      // onAutoAnchor is stitched in by the impure wrapper so it can capture the anchored mandate.
    },
    matchedMandate,
  };
}

export interface AuthorSolProposedSpecResult {
  authored: boolean;
  slug: string;
  anchoredMandateSlug: string | null;
  anchoredMandateHeading: string | null;
  anchoredBy: "llm" | "auto" | null;
  reason?: string;
}

/**
 * Impure wrapper: resolves CS mandates, calls `authorSpecRowStructured` with the pure-built args,
 * and captures the auto-anchored mandate (when the chokepoint's Phase-2 fallback picks one) so the
 * worker can log which CS mandate the roadmap row landed under. Same intendedStatusSetBy shape
 * `improve-plan-executor` uses; distinct string (`box:sol-ticket-handle`) so the audit trail
 * distinguishes Sol first-touch authorship from Improve co-pilot authorship.
 */
export async function authorSolProposedPortalErrorSpec(
  workspaceId: string,
  ticketId: string,
  spec: SolProposedSpec,
): Promise<AuthorSolProposedSpecResult> {
  const { authorSpecRowStructured } = await import("@/lib/author-spec");
  const { resolveFunctionMandates } = await import("@/lib/function-mandates");
  const csMandates = await resolveFunctionMandates("cs");
  const { slug, input, opts, matchedMandate } = buildAuthorSpecArgs(ticketId, spec, csMandates);
  let anchoredMandateSlug: string | null = matchedMandate?.slug ?? null;
  let anchoredMandateHeading: string | null = matchedMandate?.heading ?? null;
  const anchoredBy: "llm" | "auto" | null = matchedMandate ? "llm" : null;
  let sawAutoAnchor = false;
  const authored = await authorSpecRowStructured(workspaceId, slug, input, "planned", {
    ...opts,
    onAutoAnchor: (r: AutoAnchorResult) => {
      anchoredMandateSlug = r.mandate.slug;
      anchoredMandateHeading = r.mandate.heading;
      sawAutoAnchor = true;
    },
  });
  return {
    authored,
    slug,
    anchoredMandateSlug,
    anchoredMandateHeading,
    anchoredBy: matchedMandate ? "llm" : sawAutoAnchor ? "auto" : null,
  };
}
