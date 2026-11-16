/**
 * Unit tests for `isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise` — the
 * capture-time noise drop for a foreign/stale PostgREST client that selects the nonexistent
 * `ticket_messages.attachments` column against `public.ticket_messages`. Built-in node:test —
 * no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.ticket-messages-attachments-noise.test.ts
 *
 * ShopCX's `ticket_messages` never carried an `attachments` column and no ShopCX code path
 * selects it; the offending read is not ShopCX code (Control Tower signature
 * `supabase-logs:6a96a3470d2d7a8e`). Drop AT CAPTURE only when BOTH the exact
 * `column ticket_messages.attachments does not exist` message AND the SELECT-lookup shape on
 * `ticket_messages` (bare or PostgREST CTE wrapper) are present. A different column on
 * ticket_messages, a different table, and a non-SELECT statement still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise drops the PostgREST CTE wrapper + bare SELECT listing the non-existent attachments column", () => {
  // The captured incident shape: a stale direct-REST client lists ticket_messages selecting
  // attachments, PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM
  // "public"."ticket_messages" ... )` CTE, and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "column ticket_messages.attachments does not exist",
      'WITH pgrst_source AS ( SELECT "public"."ticket_messages"."id", "public"."ticket_messages"."attachments" FROM "public"."ticket_messages" ORDER BY "public"."ticket_messages"."id" DESC LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "column public.ticket_messages.attachments does not exist",
      'with pgrst_source as ( select "public"."ticket_messages"."attachments" from "public"."ticket_messages" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "ERROR: column ticket_messages.attachments does not exist",
      'WITH pgrst_source AS ( SELECT "attachments" FROM "public"."ticket_messages" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "column ticket_messages.attachments does not exist",
      "select id, attachments from public.ticket_messages order by id desc limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "column ticket_messages.attachments does not exist",
      "select * from ticket_messages where attachments is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise KEEPS real errors (other column, other table, non-SELECT)", () => {
  // A DIFFERENT column on ticket_messages (a real column rename that broke a live query) still
  // pages — the pin is attachments only.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "column ticket_messages.body does not exist",
      "select id, body from public.ticket_messages",
    ),
    false,
  );
  // Same attachments-missing message on a DIFFERENT relation is a real product-schema
  // regression and still pages — the pin names ticket_messages only.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "column messages.attachments does not exist",
      "select id, attachments from public.messages order by id desc",
    ),
    false,
  );
  // A non-SELECT shape (PostgREST CTE write / bare write) is a real code-bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "column ticket_messages.attachments does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."ticket_messages"("id","attachments") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "column ticket_messages.attachments does not exist",
      "update public.ticket_messages set attachments = $1 where id = $2",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "FATAL: terminating connection due to administrator command",
      "select id, attachments from public.ticket_messages",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise("", "select * from ticket_messages"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesAttachmentsColumnNoise(
      "column ticket_messages.attachments does not exist",
      "",
    ),
    false,
  );
});
