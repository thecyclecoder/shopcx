/**
 * Regression pin for the delivery-chokepoint placeholder guarantee
 * (docs/brain/specs/no-send-path-can-emit-an-unsubstituted-placeholder Phase 3).
 *
 * A customer must never receive a raw `{{token}}`. The rail lives at the send
 * chokepoint (`resolvePlaceholderSafeMessage`), not at the composing callers —
 * because at least three composers forgot the helper and customers read literal
 * "{{label_url}}": Ethel Hutton (BBB complaint, ticket 2305546a) and Julianne
 * Peters (15 days unresolved, ticket de357c10), 2026-07-28..29. These tests
 * pin the three named cases so the next composing path added is bound by the
 * chokepoint's guarantee, not by a caller-side courtesy.
 *
 * Run:  npx tsx --test src/lib/ticket-delivery.placeholder-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlaceholderSafeMessage } from "./ticket-delivery";

type Admin = Parameters<typeof resolvePlaceholderSafeMessage>[0];

const LIVE_LABEL =
  "https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260728/ethel-hutton.png";

/**
 * Tiny in-memory admin stub that answers only the `returns` query the guard
 * runs. Every other `.from(...)` returns `data: null` so an accidental read
 * would fail loudly — we're only testing the guard.
 */
function stubAdmin(returnsRow: { id: string; label_url: string; status: string; created_at: string } | null): Admin {
  const returnsHandle = {
    select: (_cols: string) => returnsHandle,
    eq: (_col: string, _val: unknown) => returnsHandle,
    not: (_col: string, _op: string, _val: unknown) => returnsHandle,
    order: (_col: string, _opts: unknown) => returnsHandle,
    limit: (_n: number) => returnsHandle,
    async maybeSingle() {
      return { data: returnsRow };
    },
  };
  const emptyHandle = {
    select: (_cols: string) => emptyHandle,
    eq: (_col: string, _val: unknown) => emptyHandle,
    async maybeSingle() {
      return { data: null };
    },
    async single() {
      return { data: null };
    },
  };
  return {
    from(table: string) {
      if (table === "returns") return returnsHandle as unknown as ReturnType<Admin["from"]>;
      return emptyHandle as unknown as ReturnType<Admin["from"]>;
    },
  } as unknown as Admin;
}

test("(a) a fillable {{label_url}} — a live return exists — is substituted to a real CTA link", async () => {
  const admin = stubAdmin({
    id: "return-1",
    label_url: LIVE_LABEL,
    status: "label_created",
    created_at: "2026-07-28T10:00:00Z",
  });

  const out = await resolvePlaceholderSafeMessage(
    admin,
    "workspace-1",
    "ticket-1",
    "cust-1",
    "Here is the label again:\n\n{{label_url}}",
  );

  assert.ok(!out.includes("{{label_url}}"), "literal token must be gone");
  assert.ok(out.includes(`href="${LIVE_LABEL}"`), "real label rendered as href");
  assert.ok(out.includes("Download your prepaid return label"), "CTA button label present");
});

test("(b) an unfillable {{label_url}} — Ethel/Julianne shape, label lives on the return — is filled from the live return record", async () => {
  const admin = stubAdmin({
    id: "return-ethel",
    label_url: LIVE_LABEL,
    status: "open",
    created_at: "2026-07-15T08:30:00Z",
  });

  const out = await resolvePlaceholderSafeMessage(
    admin,
    "workspace-1",
    "ticket-2305546a",
    "cust-ethel",
    "Here is the label:\n\n{{label_url}}",
  );

  assert.ok(!out.includes("{{label_url}}"), "no literal token reaches the customer");
  assert.ok(!/\{\{|\[[A-Z_]+\]/.test(out), "no residual braces or bracket tokens");
  assert.ok(out.includes(`href="${LIVE_LABEL}"`), "the live return's label URL is the fallback");
});

test("(c) an unfillable token with NO live return is delivered clean, with no residual braces or bracket tokens", async () => {
  const admin = stubAdmin(null);

  const out = await resolvePlaceholderSafeMessage(
    admin,
    "workspace-1",
    "ticket-3",
    "cust-2",
    "Your tracking is {{tracking_number}} via {{carrier}}. [LABEL_URL]",
  );

  assert.ok(!out.includes("{{"), "no residual {{ opener");
  assert.ok(!out.includes("}}"), "no residual }} closer");
  assert.ok(!/\[\s*[A-Z_]+\s*\]/.test(out), "no residual [UPPER_TOKEN]");
  assert.ok(!out.includes("{{label_url}}"), "label_url token gone even without a live return");
  assert.ok(!out.includes("{{tracking_number}}"), "tracking_number stripped");
});

test("(d) a message with no tokens is unchanged (idempotent no-op when upstream already substituted)", async () => {
  const admin = stubAdmin(null);
  const input = "Your $12.34 refund has been issued and should appear in 3–5 business days.";
  const out = await resolvePlaceholderSafeMessage(admin, "workspace-1", "ticket-4", "cust-3", input);
  assert.equal(out, input, "no tokens ⇒ identical passthrough");
});

test("(e) never guess across customers — a null customerId skips the live-return fallback and the token is stripped", async () => {
  // Even if a return row exists, we must NOT read it when the ticket has no
  // customer_id — the spec says "Never guess across customers". The strip
  // must still fire so the raw brace never reaches anyone.
  const admin = stubAdmin({
    id: "return-someone-else",
    label_url: LIVE_LABEL,
    status: "label_created",
    created_at: "2026-07-28T10:00:00Z",
  });
  const out = await resolvePlaceholderSafeMessage(
    admin,
    "workspace-1",
    "ticket-anon",
    null,
    "Here is your label: {{label_url}}",
  );
  assert.ok(!out.includes("{{label_url}}"), "token stripped, not substituted from someone else's return");
  assert.ok(!out.includes(LIVE_LABEL), "no cross-customer bleed");
});
