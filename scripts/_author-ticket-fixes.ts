import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company
const OPTS = {
  intendedStatusSetBy: "ceo" as const,
  parentKind: "mandate" as const,
  parentRef: "cs#ticket-derived-product-fixes",
};

async function authorGmailSpec() {
  return authorSpecRowStructured(
    WORKSPACE_ID,
    "identity-gmail-canonicalization-and-dot-insensitive-matching",
    {
      title: "Gmail-canonical identity: stop spawning shadow customer records + match dot/plus variants",
      why:
        "A real, active subscriber (ticket 54f0f29e — Julie Metz) was invisible to every self-serve tool because her support email metz.julie323@gmail.com is a Gmail dot-variant of her real record metzjulie323@gmail.com. Gmail ignores dots and +tags, but our inbound-email ingest does an EXACT-string customer lookup, so it spawned a brand-new EMPTY customer record. With no name/phone/address and a mismatched email-local, findUnlinkedMatches had nothing to match on and get_customer_account / get_link_candidates correctly returned nothing — Sol and June were handed an orphan and truthfully reported 'no such account'. Measured prevalence: 180 true gmail dot/plus-variant collision groups and 404 empty shadow customer records, some shadowing high-value accounts (e.g. a 33-order customer with an empty dot-variant twin).",
      what:
        "Add a canonicalizeEmail() helper; store an indexed customers.email_canonical; use it at inbound-email ingest to ATTACH to the existing record instead of creating a shadow; and make the findUnlinkedMatches email branch match on the canonical so historical dup records are found. Derived-from-ticket: 54f0f29e.",
      summary:
        "Identity fix across three call sites: src/lib/email-utils.ts (new canonicalizeEmail), src/app/api/webhooks/email/route.ts:297-335 (exact .eq('email', normalizedEmail) get-or-create that spawned the shadow), and src/lib/account-matching.ts:157-158 (the email branch's exact ilike('${local}@%')). Backed by an indexed customers.email_canonical column + idempotent backfill (ship-time-backfill convention).",
      owner: "cs",
      parent:
        '[[../functions/cs]] — "Ticket-derived product fixes" mandate: a real subscriber was unreachable by Sol/June because inbound-email identity resolution is not Gmail-aware; this is the structural fix so the class does not recur. Derived-from-ticket: 54f0f29e.',
      blocked_by: [],
      human_review:
        "After ship, spot-check a few of the 404 shadow-record groups (e.g. erinhadary@gmail.com vs erin.hadary@gmail.com) and confirm new inbound from a dot-variant attaches to the real record instead of creating an empty one.",
      phases: [
        {
          title: "Phase 1 — canonicalizeEmail() helper",
          why:
            "There is no email-canonicalization helper today — the email-utils library only has display strippers. Every downstream fix needs one shared, pure, unit-testable canonicalizer so ingest and matching agree on what two addresses being 'the same inbox' means.",
          what:
            "Add exported pure canonicalizeEmail(email: string): string. Always trim + lowercase. For gmail.com/googlemail.com ONLY: strip '.' and drop everything from '+' in the local part, and normalize googlemail.com→gmail.com. For every other domain: trim+lowercase ONLY — never strip dots (other providers treat dots as significant).",
          body:
            "Add `export function canonicalizeEmail(email: string): string` to src/lib/email-utils.ts. Rules: lowercase+trim; split on '@'; if domain is gmail.com or googlemail.com, remove all '.' from the local part and truncate the local part at the first '+', and canonicalize the domain to gmail.com; otherwise return `${localLower}@${domainLower}` unchanged. Pure, no I/O. Add unit coverage in src/lib/email-utils.test.ts (dot-variant, +tag, googlemail alias, non-gmail dot preserved, malformed input). Update docs/brain/libraries/email-utils.md with the new export (CLAUDE.md brain-page rule).",
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- grep `export function canonicalizeEmail` in src/lib/email-utils.ts → expect present.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "canonicalizeEmail exported from email-utils",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "export function canonicalizeEmail", path: "src/lib/email-utils.ts", expect: "present" },
            },
          ],
        },
        {
          title: "Phase 2 — indexed customers.email_canonical column + backfill",
          why:
            "The ingest lookup and the matcher both need an indexed key to resolve/join gmail variants without an unindexed scan over 252k gmail customers. A stored, indexed canonical column is that key.",
          what:
            "Add nullable customers.email_canonical (text, indexed), populate it via canonicalizeEmail on every customer write, and backfill existing rows idempotently (ship-time-backfill convention: an idempotent scripts/_backfill-*.ts auto-ledgered to data_op_runs, OR an idempotent SQL migration).",
          body:
            "Migration supabase/migrations/YYYYMMDDNNNNNN_customers_email_canonical.sql: add `email_canonical text` + `CREATE INDEX idx_customers_email_canonical ON customers (workspace_id, email_canonical)`. Populate email_canonical = canonicalizeEmail(email) wherever a customer row is created/updated (the email webhook create at src/app/api/webhooks/email/route.ts and other customer inserts). Backfill historical rows idempotently per CLAUDE.md ship-time-backfill rule (idempotent scripts/_backfill-customers-email-canonical.ts ledgered to data_op_runs via detectAndEscalateShipTimeBackfills, OR an idempotent UPDATE in the migration). Update docs/brain/tables/customers.md with the new column + index (brain-page rule).",
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- grep `email_canonical` in the changed source (migration + write path) → expect present.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "email_canonical column/index introduced",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "email_canonical", expect: "present" },
            },
          ],
        },
        {
          title: "Phase 3 — inbound-email ingest attaches to the canonical match (no more shadow records)",
          why:
            "The exact-string get-or-create in the inbound-email webhook is precisely where Julie's empty shadow record was born. Attaching to an existing canonical match instead of inserting a new row prevents the shadow at the source.",
          what:
            "When the exact .eq('email', normalizedEmail) lookup misses AND canonicalizeEmail(normalizedEmail) differs from normalizedEmail, look up an existing customer in the workspace by email_canonical; if found, attach the ticket to THAT customer instead of creating a new record. Never rewrite the existing record's stored email. Only create a new record when no exact AND no canonical match exists.",
          body:
            "In src/app/api/webhooks/email/route.ts, in the new-ticket 'resolve or create customer' block (lines ~294-335): after the exact `.eq('email', normalizedEmail).single()` miss, compute `canonicalizeEmail(normalizedEmail)`; if it differs, query `customers` by `(workspace_id, email_canonical)` and, on a hit, set customerId to that row (do NOT upsert a new row). Keep the existing race-safe upsert path only for the genuine no-match case. Add a system note when a ticket attaches to a canonical sibling so the audit trail is explicit. This is the fix that would have prevented ticket 54f0f29e entirely.",
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- grep `email_canonical` in src/app/api/webhooks/email/route.ts → expect present.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "ingest consults email_canonical",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "email_canonical", path: "src/app/api/webhooks/email/route.ts", expect: "present" },
            },
          ],
        },
        {
          title: "Phase 4 — dot-insensitive email branch in findUnlinkedMatches",
          why:
            "Even with Phase 3 preventing NEW shadows, 404 historical dup records already exist. The matcher's email branch does an exact email-local match today, so it can't join a gmail variant to its real twin. Matching on the canonical rescues the existing dups and is a second net for the whole class.",
          what:
            "Change the findUnlinkedMatches email branch to match candidates by email_canonical equality (canonicalize the source's email, match rows sharing that canonical) rather than exact email-local ilike, so gmail dot/plus variants surface as candidates for grading.",
          body:
            "In src/lib/account-matching.ts findUnlinkedMatches (email branch at lines 157-158): compute the source customer's canonical (canonicalizeEmail) and add/replace the email branch to select candidates where email_canonical equals the source canonical (indexed by Phase 2). Keep the name/phone/address grading unchanged — this only widens the email branch's candidate set. Add a unit case to src/lib/account-matching.test.ts proving a dot-variant twin is surfaced. Update docs/brain/libraries/account-matching.md.",
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- grep `email_canonical` in src/lib/account-matching.ts → expect present.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "matcher email branch uses email_canonical",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "email_canonical", path: "src/lib/account-matching.ts", expect: "present" },
            },
          ],
        },
      ],
    },
    "planned",
    OPTS,
  );
}

async function authorSilentTurnSpec() {
  return authorSpecRowStructured(
    WORKSPACE_ID,
    "post-resolution-inbound-reroute-and-silent-turn-guard",
    {
      title: "Never resume a stale playbook after a director resolution; never end a turn silent",
      why:
        "Ticket eca3f43b (Melissa): after June (CS Director) resolved the ticket with an in-flight return, a later customer reply was resumed onto the STALE pre-escalation refund playbook — which found nothing to do, tried to cancel her subscription (it FAILED), and sent her ZERO customer-facing text. The root cause is that the playbook-supersede guard clears the active playbook only when a human agent has replied externally; June resolved as an AI CS-director, so the playbook stayed active and got wrongly resumed. The customer was left unanswered. Measured: of 13 recently-backstopped tickets, 5 ended with no customer-facing reply.",
      what:
        "Two structural guards: (1) a CS-director/AI resolution supersedes the active playbook the same way a human agent reply does, so a later inbound routes to Sol/Sonnet fresh (remedy-aware) instead of resuming a stale playbook; (2) a handled inbound turn that concludes with no customer-facing reply and no escalation must escalate with a holding message, so no customer is ever left silent. Derived-from-ticket: eca3f43b.",
      summary:
        "Fix in src/lib/inngest/unified-ticket-handler.ts: the supersede guard at 1445-1458 (agent-only) and the resumed-playbook exec path at 1500-1611 (which can end with neither a response nor a valid progression). Reuse the existing escalate_api_failure holding-message path (1522-1552) as the silent-turn escape hatch.",
      owner: "cs",
      parent:
        '[[../functions/cs]] — "Ticket-derived product fixes" mandate: a resolved ticket silently re-ran a stale playbook and dropped the customer; this is the structural guard so the class does not recur. Derived-from-ticket: eca3f43b.',
      blocked_by: [],
      human_review:
        "After ship, reply on a ticket June already resolved via approve_remedy and confirm the new inbound routes to Sol/Sonnet fresh (not a stale playbook) and always produces a customer-facing reply.",
      phases: [
        {
          title: "Phase 1 — a director/AI resolution supersedes the active playbook",
          why:
            "The supersede guard only fires on a human agent's external reply. A CS-director resolution (June's approve_remedy that closes and de-escalates) is authored as AI and slips through, leaving the pre-escalation playbook active to be wrongly resumed on the next inbound.",
          what:
            "Extend the supersede condition so a CS-director external resolution (June's approve_remedy / ticket close-and-de-escalate) also clears active_playbook_id (+ playbook_step/exceptions) and routes the next inbound to Sol/Sonnet. Clear it at the director-resolution write site and/or widen the handler guard's author_type set to include the director resolution.",
          body:
            "In src/lib/inngest/unified-ticket-handler.ts check-playbook guard (1445-1459): today it clears active_playbook_id only when an external author_type='agent' message exists. Widen supersession so a CS-director resolution counts — either (a) clear active_playbook_id at the cs-director approve_remedy/close applier (executeSonnetDecision / the cs-director-call applier that writes the [CS Director review] note + closes the ticket), or (b) extend the guard here to treat a director external resolution after the playbook started as superseding. On supersede, drop the same '[System] Active playbook cleared …' note pattern. Net: a new inbound on a June-resolved ticket routes to Sol first-touch (remedy-aware) instead of resuming the stale refund playbook. Cite the guard lines in the brain lifecycle page docs/brain/lifecycles/cancel-flow.md / ai-multi-turn.md as appropriate.",
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- grep `active_playbook_id` co-located with director-resolution supersede logic in src/lib/inngest/unified-ticket-handler.ts → expect present.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "handler supersedes playbook on a director resolution",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "director", path: "src/lib/inngest/unified-ticket-handler.ts", expect: "present" },
            },
          ],
        },
        {
          title: "Phase 2 — silent-turn guard: no reply → escalate with a holding message",
          why:
            "The resumed refund playbook produced neither a customer-facing response nor a valid progression, and its cancel mutation failed silently — so the customer got nothing back at all. Measured: 5 of 13 backstopped tickets ended silent. A handled inbound must never end without a customer-facing reply or an explicit escalation.",
          what:
            "Add a post-turn guard: when a handled non-new inbound concludes with no customer-facing external reply sent and no escalation raised (a dead playbook resume, or a failed remedy mutation), escalate with the existing holding message and route to the To-Do/escalation path, reusing the escalate_api_failure holding-message + Slack path. The silent-turn concept already exists as a read-side diagnostic in buildTurnTimeline — promote it to a runtime assertion so no customer is ever left in silence.",
          body:
            "In src/lib/inngest/unified-ticket-handler.ts, after the resumed-playbook exec path (1500-1611) and any turn that can conclude without a send: assert that a customer-facing external reply was produced OR an escalation was raised; if neither, run the holding-message + escalate path already implemented at 1522-1552 (escalate_api_failure) so the customer is never left in silence and a human is notified. Explicitly cover (a) a playbook step returning no response and no valid advance/complete, and (b) a failed subscription mutation inside the playbook. Add the guard's condition as a small pure helper for unit coverage, mirroring buildTurnTimeline's silentTurn detection.",
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- grep `I need a little time to work on this` in src/lib/inngest/unified-ticket-handler.ts → expect present (the holding-message escape hatch is wired for the silent-turn case).",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "silent-turn escape hatch sends a holding message",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "I need a little time to work on this", path: "src/lib/inngest/unified-ticket-handler.ts", expect: "present" },
            },
          ],
        },
      ],
    },
    "planned",
    OPTS,
  );
}

async function main() {
  const a = await authorGmailSpec();
  console.log("gmail-canonicalization spec:", a ? "authored" : "FAILED");
  const b = await authorSilentTurnSpec();
  console.log("silent-turn-guard spec:", b ? "authored" : "FAILED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
